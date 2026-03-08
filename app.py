import io
import os
import base64
import tempfile

import exifread
import numpy as np
import rawpy
from flask import Flask, jsonify, request, send_from_directory
from PIL import Image

app = Flask(__name__, static_folder="static")

MAX_PREVIEW_WIDTH = 1600  # px per side for preview JPEG


def fraction_to_float(value):
    """Convert an exifread IFDRatio or similar to float."""
    try:
        return float(value.num) / float(value.den)
    except (AttributeError, ZeroDivisionError):
        try:
            return float(value)
        except Exception:
            return None


def parse_exif(file_path):
    """Extract relevant EXIF fields from a RAW file."""
    exif = {
        "f_number": None,
        "iso": None,
        "shutter_speed": None,
        "shutter_speed_raw": None,
        "focal_length": None,
        "camera": None,
        "lens": None,
        "exposure_program": None,
    }

    with open(file_path, "rb") as f:
        tags = exifread.process_file(f, details=False)

    if "EXIF FNumber" in tags:
        exif["f_number"] = fraction_to_float(tags["EXIF FNumber"].values[0])

    if "EXIF ISOSpeedRatings" in tags:
        val = tags["EXIF ISOSpeedRatings"]
        try:
            exif["iso"] = int(str(val))
        except ValueError:
            exif["iso"] = str(val)

    if "EXIF ExposureTime" in tags:
        val = tags["EXIF ExposureTime"]
        exif["shutter_speed_raw"] = str(val)
        try:
            v = val.values[0]
            exif["shutter_speed"] = fraction_to_float(v)
        except Exception:
            exif["shutter_speed"] = None

    if "EXIF FocalLength" in tags:
        exif["focal_length"] = fraction_to_float(tags["EXIF FocalLength"].values[0])

    make = str(tags.get("Image Make", "")).strip()
    model = str(tags.get("Image Model", "")).strip()
    exif["camera"] = f"{make} {model}".strip() or None

    if "EXIF LensModel" in tags:
        exif["lens"] = str(tags["EXIF LensModel"]).strip()

    return exif


def raw_to_jpeg_bytes(file_path, max_width=MAX_PREVIEW_WIDTH):
    """Convert RAW file to resized JPEG bytes using rawpy."""
    with rawpy.imread(file_path) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            no_auto_bright=True,
            output_bps=8,
            half_size=False,
        )

    img = Image.fromarray(rgb)

    # Downscale for web preview while keeping aspect ratio
    if img.width > max_width:
        ratio = max_width / img.width
        new_size = (max_width, int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92, optimize=True)
    return buf.getvalue()


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Determine suffix for temp file
    _, ext = os.path.splitext(file.filename)
    suffix = ext.lower() if ext else ".arw"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    try:
        exif = parse_exif(tmp_path)
        jpeg_bytes = raw_to_jpeg_bytes(tmp_path)
        img_b64 = base64.b64encode(jpeg_bytes).decode("ascii")

        return jsonify({"image": img_b64, "exif": exif})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    app.run(debug=True, port=5050, host="127.0.0.1")
