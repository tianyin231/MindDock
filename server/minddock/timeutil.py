"""时间换算：数据库统一存 UTC，展示和 AI 解析用配置的时区。"""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

WEEKDAYS = "一二三四五六日"


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def to_utc_iso(value: str | None, tz: str) -> str | None:
    """把 AI 给出的时间（可能不带时区）换算成 UTC 字符串；无法解析时返回 None。"""
    if not value:
        return None
    try:
        moment = parse_iso(value.strip())
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=ZoneInfo(tz))
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_now(tz: str) -> datetime:
    return datetime.now(ZoneInfo(tz))


def describe_now(tz: str) -> str:
    now = local_now(tz)
    return f"{now.strftime('%Y-%m-%d %H:%M')}（星期{WEEKDAYS[now.weekday()]}，{tz}）"


def friendly(utc_iso: str, tz: str) -> str:
    """今天 15:00 / 明天 09:00 / 10月28日 周二 20:00"""
    moment = parse_iso(utc_iso).astimezone(ZoneInfo(tz))
    days = (moment.date() - local_now(tz).date()).days
    hm = moment.strftime("%H:%M")
    if days == 0:
        return f"今天 {hm}"
    if days == 1:
        return f"明天 {hm}"
    if days == 2:
        return f"后天 {hm}"
    return f"{moment.month}月{moment.day}日 周{WEEKDAYS[moment.weekday()]} {hm}"
