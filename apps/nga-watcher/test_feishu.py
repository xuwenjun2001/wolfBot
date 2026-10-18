import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

from feishu import DEFAULT_CONFIG, FeishuClient, build_payload, enqueue_posts, read_config, validate_config
from monitor_state import AUTHORS, prepare_monitors
from watcher import App, AuthorMonitor, AuthorSearchClient, read_state, save_state


CONFIG = {'enabled': True, 'app_id': 'cli_example', 'app_secret': 'example-secret',
          'receive_id_type': 'email', 'receive_id': 'me@example.com'}
POST = {'pid': 42, 'date': '2026-10-13 09:30', 'content': '新的发言', 'page': 1}


class Response(io.BytesIO):
    status = 200

    def __init__(self, data):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())


class FeishuTests(unittest.TestCase):
    def mock_app(self):
        app = App.__new__(App)
        app.state = prepare_monitors({'watermark': 42, 'page': 1, 'pending': [POST], 'recent': [],
                                      'feishu_outbox': [POST]})
        app.feishu_config = dict(CONFIG)
        app.feishu_status = Mock()
        app.status = Mock()
        app.feishu_busy = True
        app.feishu_storage_error = False
        app.targets = {str(uid): AuthorMonitor(uid, AuthorSearchClient(author=uid)) for uid in AUTHORS}
        app.targets[str(AUTHORS[0])].busy = True
        app.render_posts = Mock()
        app.show_alert = Mock()
        return app

    def test_missing_configuration_is_disabled(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(read_config(Path(directory) / 'feishu.json'), DEFAULT_CONFIG)

    def test_validate_receiver_and_credentials(self):
        self.assertEqual(validate_config(CONFIG), CONFIG)
        for changes in [{'app_id': ''}, {'app_secret': ''}, {'receive_id': ''},
                        {'receive_id': 'bad-email'}, {'receive_id_type': 'chat_id'},
                        {'receive_id_type': 'open_id', 'receive_id': 'wrong'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_config(dict(CONFIG, **changes))

    def test_message_links_to_exact_post_and_bounds_length(self):
        payload = build_payload(CONFIG, dict(POST, content='长' * 10000))
        text = json.loads(payload['content'])['text']
        self.assertEqual(payload['receive_id'], CONFIG['receive_id'])
        self.assertIn('pid=42', text)
        self.assertIn(POST['date'], text)
        self.assertIn('点击原帖', text)
        self.assertLess(len(json.dumps(payload, ensure_ascii=False).encode('utf-8')), 20000)

    def test_retry_uuid_survives_restart_and_is_specific_to_recipient(self):
        self.assertEqual(build_payload(CONFIG, POST)['uuid'], build_payload(CONFIG, copy.deepcopy(POST))['uuid'])
        self.assertNotEqual(build_payload(CONFIG, POST)['uuid'], build_payload(dict(CONFIG, receive_id='other@example.com'), POST)['uuid'])
        self.assertNotEqual(build_payload(CONFIG)['uuid'], build_payload(CONFIG)['uuid'])

    def test_cross_thread_messages_link_to_their_actual_topic(self):
        post = dict(POST, tid=47710788, subject='新的主题')
        payload = build_payload(CONFIG, post)
        text = json.loads(payload['content'])['text']
        self.assertIn('tid=47710788&pid=42', text)
        self.assertIn('新的主题', text)
        self.assertNotIn('tid=47559481', text)
        self.assertNotEqual(payload['uuid'], build_payload(CONFIG, POST)['uuid'])

    def test_message_identifies_the_actual_monitored_author(self):
        for author in AUTHORS:
            text = json.loads(build_payload(CONFIG, dict(POST, authorid=author))['content'])['text']
            self.assertIn(f'UID {author}\n', text)

    def test_topic_roots_are_deduplicated_by_topic_and_pid(self):
        first, second = dict(POST, tid=100, pid=0), dict(POST, tid=200, pid=0)
        state = enqueue_posts({}, [first, second, first])
        self.assertEqual(len(state['feishu_outbox']), 2)
        self.assertNotEqual(build_payload(CONFIG, first)['uuid'], build_payload(CONFIG, second)['uuid'])

    def test_delivery_acknowledges_only_the_matching_topic_root(self):
        app = self.mock_app()
        first, second = dict(POST, tid=100, pid=0), dict(POST, tid=200, pid=0)
        app.state['feishu_outbox'] = [first, second]
        with patch('watcher.save_state'):
            app.handle_feishu_event('feishu_ok', '100:0')
        self.assertEqual(app.state['feishu_outbox'], [second])

    def test_token_auth_and_message_content_and_cache(self):
        client = FeishuClient(CONFIG)
        responses = [Response({'code': 0, 'tenant_access_token': 'test-token', 'expire': 7200}),
                     Response({'code': 0, 'data': {'message_id': 'om_first'}}),
                     Response({'code': 0, 'data': {'message_id': 'om_second'}})]
        with patch('feishu.urllib.request.build_opener') as builder, patch('feishu.time.monotonic', return_value=100):
            opener = builder.return_value
            opener.open.side_effect = responses
            client.send(POST)
            client.send(dict(POST, pid=43))
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(len(requests), 3)
        self.assertTrue(requests[0].full_url.endswith('/auth/v3/tenant_access_token/internal'))
        self.assertEqual(json.loads(requests[0].data)['app_secret'], CONFIG['app_secret'])
        self.assertTrue(requests[1].full_url.endswith('/im/v1/messages?receive_id_type=email'))
        self.assertEqual(requests[1].get_header('Authorization'), 'Bearer test-token')
        self.assertIn('新的发言', json.loads(json.loads(requests[1].data)['content'])['text'])

    def test_expired_token_is_refreshed(self):
        client = FeishuClient(CONFIG)
        client.token, client.token_until = 'expired', 50
        with patch('feishu.time.monotonic', return_value=100), patch.object(client, 'request', return_value={'code': 0, 'tenant_access_token': 'renewed', 'expire': 7200}) as request:
            self.assertEqual(client.access_token(), 'renewed')
            request.assert_called_once()

    def test_http_200_business_failure_and_invalid_replies_are_rejected(self):
        for body in [{'code': 230006, 'msg': 'example-secret'}, {}, {'code': False}, b'not JSON']:
            with self.subTest(body=body), patch('feishu.urllib.request.build_opener') as builder:
                builder.return_value.open.return_value = Response(body)
                with self.assertRaises(RuntimeError) as caught:
                    FeishuClient(CONFIG).request('/im/v1/messages', {})
                self.assertNotIn('example-secret', str(caught.exception))

    def test_network_and_http_error_messages_do_not_expose_credentials(self):
        failures = [TimeoutError('example-secret'),
                    urllib.error.HTTPError('https://host/example-secret', 403, 'example-secret', {}, io.BytesIO(b'{"code":403,"msg":"example-secret"}'))]
        for error in failures:
            with self.subTest(error=type(error).__name__), patch('feishu.urllib.request.build_opener') as builder:
                builder.return_value.open.side_effect = error
                with self.assertRaises(RuntimeError) as caught:
                    FeishuClient(CONFIG).request('/im/v1/messages', {})
                self.assertNotIn('example-secret', str(caught.exception))

    def test_http_400_includes_required_permission_and_error_code(self):
        reply = {'code': 99991672, 'msg': 'Access denied example-secret',
                 'error': {'permission_violations': [{'subject': 'contact:user.employee_id:readonly'}]}}
        error = urllib.error.HTTPError('https://open.feishu.cn/open-apis/im/v1/messages',
                                      400, 'Bad Request', {}, io.BytesIO(json.dumps(reply).encode()))
        with patch('feishu.urllib.request.build_opener') as builder:
            builder.return_value.open.side_effect = error
            with self.assertRaises(RuntimeError) as caught:
                FeishuClient(CONFIG).request('/im/v1/messages', {})
        self.assertIn('99991672', str(caught.exception))
        self.assertIn('contact:user.employee_id:readonly', str(caught.exception))
        self.assertNotIn('example-secret', str(caught.exception))

    def test_permission_error_does_not_echo_arbitrary_fields(self):
        reply = {'code': 99991672, 'error': {'permission_violations': [{'subject': 'example-secret'}]}}
        with patch('feishu.urllib.request.build_opener') as builder:
            builder.return_value.open.return_value = Response(reply)
            with self.assertRaises(RuntimeError) as caught:
                FeishuClient(CONFIG).request('/im/v1/messages', {})
        self.assertNotIn('example-secret', str(caught.exception))

    def test_success_without_message_id_does_not_acknowledge_delivery(self):
        client = FeishuClient(CONFIG)
        client.token, client.token_until = 'test-token', float('inf')
        with patch.object(client, 'request', return_value={'code': 0, 'data': {}}):
            with self.assertRaisesRegex(RuntimeError, '消息 ID'):
                client.send(POST)
        self.assertEqual(client.token, '')

    def test_outbox_survives_desktop_ack_and_restart_without_duplicates(self):
        state = enqueue_posts({'watermark': 42, 'page': 1, 'pending': [POST]}, [POST, POST])
        state['pending'] = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            save_state(state, path)
            restarted = read_state(path)
        self.assertEqual(restarted['pending'], [])
        self.assertEqual(restarted['feishu_outbox'], [POST])

    def test_failed_delivery_preserves_outbox_and_poll_status(self):
        app = self.mock_app()
        before = copy.deepcopy(app.state)
        app.handle_feishu_event('feishu_error', '网络超时')
        self.assertEqual(app.state, before)
        self.assertTrue(app.busy)
        self.assertFalse(app.feishu_busy)

    def test_successful_delivery_does_not_clear_desktop_pending(self):
        app = self.mock_app()
        with patch('watcher.save_state') as save:
            app.handle_feishu_event('feishu_ok', 42)
            save.assert_called_once()
        self.assertEqual(app.state['pending'], [POST])
        self.assertEqual(app.state['feishu_outbox'], [])

    def test_inflight_poll_cannot_revive_sent_notifications(self):
        app = self.mock_app()
        stale_result = dict(copy.deepcopy(app.state), rows=1)
        with patch('watcher.save_state'):
            app.handle_feishu_event('feishu_ok', 42)
            app.handle_poll_event('ok', (stale_result, [], False))
        self.assertEqual(app.state['feishu_outbox'], [])

    def test_new_posts_are_persisted_before_notification(self):
        app = self.mock_app()
        new_post = dict(POST, pid=43)
        result = dict(copy.deepcopy(app.state), rows=2, watermark=43)
        with patch('watcher.save_state') as save:
            app.handle_poll_event('ok', (result, [new_post], False))
            self.assertEqual([p['pid'] for p in save.call_args.args[0]['feishu_outbox']], [42, 43])

    def test_disabled_channel_does_not_queue_new_posts(self):
        app = self.mock_app()
        app.feishu_config['enabled'] = False
        new_post = dict(POST, pid=43)
        result = dict(copy.deepcopy(app.state), rows=2, watermark=43)
        with patch('watcher.save_state'):
            app.handle_poll_event('ok', (result, [new_post], False))
        self.assertEqual(app.state['feishu_outbox'], [POST])


if __name__ == '__main__':
    unittest.main()
