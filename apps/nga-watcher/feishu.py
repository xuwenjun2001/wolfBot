"""Direct messages from a Feishu enterprise app bot. Standard library only."""
from __future__ import annotations

from http.client import HTTPException
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
import uuid

DEFAULT_CONFIG = {'enabled': False, 'app_id': '', 'app_secret': '',
                  'receive_id_type': 'email', 'receive_id': ''}
API = 'https://open.feishu.cn/open-apis'


def validate_config(value):
    if not isinstance(value, dict):
        raise ValueError('飞书配置格式不正确')
    result = {key: value.get(key, default) for key, default in DEFAULT_CONFIG.items()}
    if not isinstance(result['enabled'], bool) or any(not isinstance(result[key], str) for key in DEFAULT_CONFIG if key != 'enabled'):
        raise ValueError('飞书配置格式不正确')
    for key in result:
        if key != 'enabled':
            result[key] = result[key].strip()
    if result['receive_id_type'] not in ('email', 'open_id', 'user_id'):
        raise ValueError('请选择邮箱、Open ID 或 User ID 作为接收人类型')
    if result['enabled']:
        if not result['app_id'].startswith('cli_') or not result['app_secret']:
            raise ValueError('请填写企业自建应用的 App ID 和 App Secret')
        if not result['receive_id'] or any(c.isspace() for c in result['receive_id']):
            raise ValueError('请填写你的飞书邮箱或用户 ID')
        if result['receive_id_type'] == 'email' and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', result['receive_id']):
            raise ValueError('接收人类型为邮箱，请填写该飞书账号的完整邮箱')
        if result['receive_id_type'] == 'open_id' and not result['receive_id'].startswith('ou_'):
            raise ValueError('Open ID 通常以 ou_ 开头，并且必须属于当前应用')
    return result


def read_config(path: Path):
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    return validate_config(json.loads(path.read_text(encoding='utf-8')))


def post_key(post):
    # A thread's first post has PID 0, so PID alone is not unique across threads.
    return f'{int(post.get("tid", 47559481))}:{int(post["pid"])}'


def post_url(post):
    return f'https://ngabbs.com/read.php?tid={int(post.get("tid", 47559481))}&pid={int(post["pid"])}'


def enqueue_posts(state, posts):
    """Queue independently of desktop acknowledgements, deduplicated by PID."""
    queued = {post_key(p): p for p in state.get('feishu_outbox', [])}
    for post in posts:
        queued.setdefault(post_key(post), dict(post))
    return dict(state, feishu_outbox=list(queued.values()))


def build_payload(config, post=None):
    if post is None:
        text = 'NGA 发言提醒 · 飞书单聊连接测试\n收到这条消息，说明机器人已能私聊你。\n监控：应用中已启用的用户发言搜索页'
        message_uuid = str(uuid.uuid4())
    else:
        content = str(post.get('content', ''))
        if len(content) > 1200:
            content = content[:1200] + '\n…正文较长，点击原帖查看完整内容'
        subject = str(post.get('subject', '')).strip()
        text = (f'NGA 新发言提醒 · UID {int(post.get("authorid", 60916468))}\n'
                f'时间：{post["date"]}  |  PID：{int(post["pid"])}\n\n'
                + (f'主题：{subject[:300]}\n\n' if subject else '') +
                f'{content or "（图片或无文本发言，请打开原帖）"}\n\n'
                f'原帖：{post_url(post)}')
        identity = f'nga:{post_key(post)}:{config["app_id"]}:{config["receive_id_type"]}:{config["receive_id"]}'
        message_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
    return {'receive_id': config['receive_id'], 'msg_type': 'text',
            'content': json.dumps({'text': text}, ensure_ascii=False), 'uuid': message_uuid}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class FeishuClient:
    def __init__(self, config):
        self.config = validate_config(config)
        self.token = ''
        self.token_until = 0

    def request(self, route, body, token=''):
        headers = {'Content-Type': 'application/json; charset=utf-8'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(API + route, data=data, headers=headers, method='POST')
        try:
            try:
                response = urllib.request.build_opener(NoRedirect()).open(request, timeout=10)
            except urllib.error.HTTPError as exc:
                # Feishu returns actionable API errors as JSON with HTTP 400.
                # Parse that body exactly like a successful HTTP response.
                response = exc
            with response:
                status = response.status
                raw = response.read(65537)
        except (OSError, HTTPException):
            raise RuntimeError('飞书网络请求失败或超时，将保留消息重试') from None
        if len(raw) > 65536:
            raise RuntimeError('飞书响应异常，未确认发送成功')
        try:
            reply = json.loads(raw)
        except (ValueError, UnicodeError):
            raise RuntimeError(f'飞书返回无效响应（HTTP {status}），未确认发送成功') from None
        code = reply.get('code') if isinstance(reply, dict) else None
        if status != 200 or type(code) is not int or code != 0:
            label = f'（错误码 {code}）' if type(code) is int else ''
            detail = reply.get('error') if isinstance(reply, dict) else None
            violations = detail.get('permission_violations', []) if isinstance(detail, dict) else []
            scopes = []
            for item in violations if isinstance(violations, list) else []:
                subject = item.get('subject') if isinstance(item, dict) else None
                if isinstance(subject, str) and re.fullmatch(r'[a-z_]+:[a-z_.]+(?::[a-z_]+)?', subject) and len(subject) <= 100:
                    scopes.append(subject)
            if code == 99991672 and scopes:
                required = ', '.join(dict.fromkeys(scopes[:10]))
                raise RuntimeError(f'飞书权限不足{label}：请开通 {required}，再发布应用新版本')
            # Do not include response text or exception text: either can echo
            # credentials. API codes suffice for diagnosing permissions.
            raise RuntimeError(f'飞书未确认成功{label}（HTTP {status}）：请检查应用凭证、发送消息权限、发布状态和接收人可用范围')
        return reply

    def access_token(self):
        if self.token and time.monotonic() < self.token_until:
            return self.token
        reply = self.request('/auth/v3/tenant_access_token/internal',
                             {'app_id': self.config['app_id'], 'app_secret': self.config['app_secret']})
        token, expiry = reply.get('tenant_access_token'), reply.get('expire')
        if not isinstance(token, str) or not token or type(expiry) is not int or expiry <= 0:
            raise RuntimeError('飞书未返回有效应用令牌，请检查 App ID 和 App Secret')
        self.token = token
        self.token_until = time.monotonic() + max(0, expiry - 60)
        return token

    def send(self, post=None):
        validate_config(dict(self.config, enabled=True))
        token = self.access_token()
        try:
            reply = self.request('/im/v1/messages?receive_id_type=' + self.config['receive_id_type'],
                                 build_payload(self.config, post), token=token)
            data = reply.get('data')
            if not isinstance(data, dict) or not isinstance(data.get('message_id'), str) or not data['message_id']:
                raise RuntimeError('飞书未返回消息 ID，未确认发送成功')
        except RuntimeError:
            self.token = ''
            self.token_until = 0
            raise
