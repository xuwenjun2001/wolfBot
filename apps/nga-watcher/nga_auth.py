"""Local NGA login-session settings; never print or log the Cookie header."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk
import webbrowser


SEARCH_URL = 'https://ngabbs.com/thread.php?searchpost=1&authorid=60916468'
SESSION_FILE = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'NGAWatcher' / 'nga-session.json'


def validate_cookie(value):
    if not isinstance(value, str):
        raise ValueError('NGA 登录态格式不正确')
    value = value.strip()
    if value.lower().startswith('cookie:'):
        value = value[7:].strip()
    if len(value) > 20000 or any(ord(char) < 32 or ord(char) > 126 for char in value):
        raise ValueError('请只粘贴请求头 Cookie 的值，不要粘贴整段请求头')
    if value and ('=' not in value or '://' in value):
        raise ValueError('请粘贴 NGA 请求头 Cookie 的值')
    return value


def load_cookie(path=SESSION_FILE):
    if not path.exists():
        return ''
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('NGA 登录态文件格式不正确')
    return validate_cookie(value.get('cookie', ''))


def save_cookie(value, path=SESSION_FILE):
    value = validate_cookie(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps({'cookie': value}, ensure_ascii=False), encoding='utf-8')
    temp.replace(path)
    return value


def open_settings(parent=None, on_save=None):
    win = tk.Toplevel(parent) if parent else tk.Tk()
    win.title('NGA 登录态 · 用户发言页监控')
    win.geometry('800x470')
    win.minsize(720, 450)
    frame = ttk.Frame(win, padding=24)
    frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='这个用户发言搜索页需要 NGA 登录态。', font=('Microsoft YaHei UI', 15, 'bold')).pack(anchor='w', pady=(0, 14))
    instructions = ('1. 在已经登录 NGA 的浏览器中打开目标用户发言页。\n'
                    '2. 按 F12，打开“网络 / Network”，再刷新页面。\n'
                    '3. 选中 thread.php?searchpost=1… 请求，打开“标头 / Headers”。\n'
                    '4. 在“请求标头 / Request Headers”中复制 Cookie 的值，粘贴到下方。\n\n'
                    '请在此窗口填写，不要把 Cookie 发到聊天里。仅保存在本机；过期后需重新填写。')
    ttk.Label(frame, text=instructions, wraplength=740, justify='left', font=('Microsoft YaHei UI', 10)).pack(anchor='w', pady=(0, 18))
    ttk.Label(frame, text='NGA Cookie').pack(anchor='w')
    try:
        initial = load_cookie()
    except (ValueError, OSError):
        initial = ''
    cookie = tk.StringVar(value=initial)
    entry = ttk.Entry(frame, textvariable=cookie, show='*')
    entry.pack(fill='x', pady=(6, 8))
    visible = tk.BooleanVar(value=False)
    ttk.Checkbutton(frame, text='显示输入', variable=visible, command=lambda: entry.configure(show='' if visible.get() else '*')).pack(anchor='w')
    status = tk.StringVar(value='已有登录态，可重新保存或替换。' if initial else '等待在本地填写 NGA 登录态。')
    ttk.Label(frame, textvariable=status, wraplength=740).pack(anchor='w', pady=16)
    actions = ttk.Frame(frame)
    actions.pack(anchor='w')

    def save():
        try:
            saved = save_cookie(cookie.get())
        except (ValueError, OSError) as exc:
            messagebox.showerror('无法保存 NGA 登录态', str(exc), parent=win)
            return
        if on_save:
            on_save(saved)
        status.set('登录态已保存。监控器会使用此登录态检查新页面。' if saved else '已清除登录态，搜索页可能要求登录。')

    ttk.Button(actions, text='保存登录态', command=save).pack(side='left', padx=(0, 10))
    ttk.Button(actions, text='打开发言页', command=lambda: webbrowser.open(SEARCH_URL)).pack(side='left', padx=(0, 10))
    ttk.Button(actions, text='关闭', command=win.destroy).pack(side='left')
    entry.focus_set()
    return win


if __name__ == '__main__':
    open_settings().mainloop()
