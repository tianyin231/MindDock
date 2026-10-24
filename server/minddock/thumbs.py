"""图片缩略图：最宽 480 像素的 WebP，永久保存在本地，面板浏览不依赖网盘速度。

视频封面需要 ffmpeg，暂不生成，面板用图标占位。
"""

from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

THUMB_WIDTH = 480
THUMB_DIR = "thumbs"
# 超过这个像素数的图片当作异常（解压炸弹），不生成缩略图
Image.MAX_IMAGE_PIXELS = 100_000_000


class ThumbnailError(ValueError):
    """图片无法识别或过大：不必重试。"""


def thumb_path_for(file_id: str, created_at: str) -> Path:
    return Path(THUMB_DIR) / created_at[:4] / created_at[5:7] / f"{file_id}.webp"


def make_thumbnail(src: Path, dest: Path) -> None:
    try:
        with Image.open(src) as img:
            # JPEG 解码时直接按目标尺寸缩小，大照片也不会占用太多内存
            img.draft("RGB", (THUMB_WIDTH * 2, THUMB_WIDTH * 2))
            frame = ImageOps.exif_transpose(img)
            keep_alpha = frame.mode in ("RGBA", "LA", "PA") or (
                frame.mode == "P" and "transparency" in frame.info
            )
            frame = frame.convert("RGBA" if keep_alpha else "RGB")
            # 宽度最多 480；长截图高度放宽到 4 倍
            frame.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 4))
            dest.parent.mkdir(parents=True, exist_ok=True)
            partial = dest.with_name(dest.name + ".part")
            frame.save(partial, "WEBP", quality=80, method=4)
            partial.replace(dest)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as exc:
        raise ThumbnailError(str(exc) or type(exc).__name__) from exc
