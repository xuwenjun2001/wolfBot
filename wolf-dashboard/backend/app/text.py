from __future__ import annotations

import html
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ParsedReply:
    body: str
    quote: str
    quote_pid: str


def parse_reply(raw: str) -> ParsedReply:
    value = raw or ""
    quote_pid = ""
    quote = ""
    match = re.match(r"\s*\[quote\]([\s\S]*?)\[/quote\]\s*", value, re.I)
    if match:
        block = match.group(1)
        pid = re.search(r"\[pid=([^,\]]+)", block, re.I)
        quote_pid = pid.group(1).strip() if pid else ""
        quote = strip_markup(block)
        value = value[match.end():]
    else:
        reply = re.match(r"\s*\[b\]\s*Reply to ([\s\S]*?)\[/b\]\s*", value, re.I)
        if reply:
            block = reply.group(1)
            pid = re.search(r"\[pid=([^,\]]+)", block, re.I)
            quote_pid = pid.group(1).strip() if pid else ""
            quote = strip_markup(block)
            value = value[reply.end():]
    return ParsedReply(strip_markup(value), quote, quote_pid)


def strip_markup(value: str) -> str:
    text = value or ""
    text = re.sub(r"\[/?(?:quote|collapse|table|tr|td|th|b|u|i|del|h|s|br)[^\]]*\]", " ", text, flags=re.I)
    text = re.sub(r"\[(?:url|img|size|color)(?:=[^\]]+)?\]", " ", text, flags=re.I)
    text = re.sub(r"\[/\w+\]", " ", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def safe_html(value: str) -> str:
    escaped = html.escape(value or "", quote=True)
    escaped = re.sub(r"\n", "<br>", escaped)
    return escaped
