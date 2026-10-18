"""Independent author progress with shared durable notification queues."""
from __future__ import annotations

import copy

from feishu import enqueue_posts, post_key

AUTHORS = (60916468, 150058)
THREADS = {150058: 47288722}
PROGRESS_FIELDS = ('watermark', 'page', 'monitor', 'search_watermark',
                   'search_seen', 'recent', 'last_success', 'rows', 'source', 'thread_id')


def search_url(author):
    return f'https://ngabbs.com/thread.php?searchpost=1&authorid={int(author)}'


def monitor_url(author):
    author = int(author)
    if author in THREADS:
        return f'https://ngabbs.com/read.php?tid={THREADS[author]}&authorid={author}'
    return search_url(author)


def author_progress(state):
    return {key: copy.deepcopy(state[key]) for key in PROGRESS_FIELDS if key in state}


def prepare_monitors(state):
    """Migrate the original author exactly; new authors start without a watermark."""
    result = copy.deepcopy(state)
    if 'authors' not in result:
        result['authors'] = {str(AUTHORS[0]): author_progress(state)}
    if not isinstance(result['authors'], dict):
        raise ValueError('多用户监控进度格式异常，请保留 state.json 后检查')
    for author in AUTHORS:
        progress = result['authors'].setdefault(str(author), {'page': 1, 'recent': []})
        if not isinstance(progress, dict) or not isinstance(progress.get('recent', []), list):
            raise ValueError(f'UID {author} 的监控进度格式异常，原进度已保留')
        tid = THREADS.get(author)
        if tid is not None and (progress.get('monitor') != 'author_thread' or progress.get('thread_id') != tid):
            # Saved search records already verified this author's exact TID/PID.
            # Carry their boundary into the narrower scope, then catch up from
            # the thread's latest page instead of treating unread posts as old.
            known = [post for post in progress.get('recent', [])
                     if post.get('tid') == tid and post.get('authorid') == author]
            if progress.get('monitor'):
                result.setdefault('previous_monitors', {})[f'{author}:{progress["monitor"]}'] = copy.deepcopy(progress)
            result['authors'][str(author)] = {
                'monitor': 'author_thread', 'thread_id': tid, 'page': 1,
                'watermark': max((post['pid'] for post in known), default=None), 'recent': known}
    recent = {post_key(post): post for author in AUTHORS
              for post in result['authors'][str(author)].get('recent', [])}
    result['recent'] = sorted(recent.values(), key=lambda post: (post.get('timestamp', 0), post_key(post)))[-70:]
    return result


def merge_author_result(state, author, progress, fresh, feishu_enabled):
    """Only commit this author's progress; never restore queues from a snapshot."""
    author = str(author)
    result = dict(state, authors=dict(state['authors']))
    result['authors'][author] = author_progress(progress)
    if author == str(AUTHORS[0]):
        # Keep legacy top-level progress available for existing state readers.
        result.update({key: result['authors'][author][key] for key in PROGRESS_FIELDS
                       if key != 'recent' and key in result['authors'][author]})
    pending = {post_key(post): post for post in state.get('pending', [])}
    pending.update({post_key(post): post for post in fresh})
    result['pending'] = list(pending.values())
    recent = {post_key(post): post for uid in AUTHORS
              for post in result['authors'][str(uid)].get('recent', [])}
    result['recent'] = sorted(recent.values(), key=lambda post: (post.get('timestamp', 0), post_key(post)))[-70:]
    if feishu_enabled:
        result = enqueue_posts(result, fresh)
    return result
