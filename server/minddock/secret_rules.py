"""密钥识别：在任何内容落盘之前判断这条消息是不是密钥。宁可误判，也不要漏掉。"""

import math
import re
from collections import Counter

_RULES = [
    ("包含私钥", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("包含 API Key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    (
        "包含 GitHub 令牌",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"),
    ),
    ("包含 AWS 访问密钥", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("包含 Slack 令牌", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}")),
    (
        "包含密码或令牌",
        re.compile(
            r"(?i)(?:password|passwd|pwd|token|secret|api[_-]?key|密码|密钥|口令)\s*[:=：]\s*\S{8,}"
        ),
    ),
]
_EXPLICIT = re.compile(r"(?i)^\s*#key(?:\s|$)")


def _looks_random(token: str) -> bool:
    if not token.isascii() or token.startswith(("http://", "https://")):
        return False
    classes = sum(
        (
            any(c.islower() for c in token),
            any(c.isupper() for c in token),
            any(c.isdigit() for c in token),
            any(not c.isalnum() for c in token),
        )
    )
    if classes < 3:
        return False
    counts = Counter(token)
    entropy = -sum(n / len(token) * math.log2(n / len(token)) for n in counts.values())
    return entropy >= 4.0


def detect_secret(text: str) -> str | None:
    """返回判定原因；不是密钥时返回 None。"""
    if _EXPLICIT.match(text):
        return "带有 #key 标记"
    for reason, pattern in _RULES:
        if pattern.search(text):
            return reason
    if any(_looks_random(token) for token in re.findall(r"\S{32,}", text)):
        return "包含疑似随机密钥的长字符串"
    return None
