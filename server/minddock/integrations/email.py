"""邮件发送：提醒的兜底渠道。"""

import smtplib
import ssl
from email.message import EmailMessage
from typing import Any


def send_email(cfg: dict[str, Any], subject: str, body: str) -> None:
    """同步发送，调用方应放到线程里执行。465 端口用 SSL，其余端口用 STARTTLS。"""
    msg = EmailMessage()
    msg["From"] = cfg["smtp_user"]
    msg["To"] = cfg["to_email"]
    msg["Subject"] = subject
    msg.set_content(body)

    host, port = cfg["smtp_host"], int(cfg.get("smtp_port") or 465)
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=15, context=context) as smtp:
            smtp.login(cfg["smtp_user"], cfg["smtp_password"])
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=15) as smtp:
            smtp.starttls(context=context)
            smtp.login(cfg["smtp_user"], cfg["smtp_password"])
            smtp.send_message(msg)
