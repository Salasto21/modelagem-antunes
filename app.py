from datetime import datetime, timezone
from pathlib import Path
import asyncio
import gzip
import hashlib
import json
import logging
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import zstandard


ROOT = Path(__file__).resolve().parent
STORAGE_DIR = Path(os.environ.get("MODEL_STORAGE_DIR", ROOT))
MODELS_DIR = STORAGE_DIR / "models"
STATIC_DIR = ROOT / "static"
DATA_DIR = STORAGE_DIR / "data"
GITHUB_SOURCES_FILE = DATA_DIR / "github_sources.json"
PREVIEWS_DIR = DATA_DIR / "previews"
MAX_UPLOAD_SIZE = 250 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".blend", ".blend1", ".glb"}
GITHUB_POLL_SECONDS = 5

MODELS_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)
PREVIEWS_DIR.mkdir(exist_ok=True)
mimetypes.add_type("model/gltf-binary", ".glb")

app = FastAPI(title="Ateliê 3D A3")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/models", StaticFiles(directory=MODELS_DIR), name="models")
app.mount("/previews", StaticFiles(directory=PREVIEWS_DIR), name="previews")
connected_clients: set[WebSocket] = set()
watcher_task: asyncio.Task | None = None
sources_lock = threading.Lock()
logger = logging.getLogger(__name__)


def find_blender() -> Path | None:
    configured = os.environ.get("BLENDER_EXECUTABLE")
    candidates = [Path(configured)] if configured else []
    on_path = shutil.which("blender")
    if on_path:
        candidates.append(Path(on_path))

    for program_files in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if program_files:
            blender_root = Path(program_files) / "Blender Foundation"
            candidates.extend(sorted(blender_root.glob("Blender*/blender.exe"), reverse=True))

    return next((candidate for candidate in candidates if candidate.is_file()), None)


def preview_path_for(filename: str) -> Path:
    name_hash = hashlib.sha256(filename.encode("utf-8")).hexdigest()
    return PREVIEWS_DIR / f"{name_hash}.glb"


def create_blend_preview(source: Path, preview_name: str | None = None) -> bool:
    blender = find_blender()
    if not blender:
        logger.warning("Blender não encontrado; sem prévia para %s", source.name)
        return False

    PREVIEWS_DIR.mkdir(exist_ok=True)
    preview_name = preview_name or source.name
    preview_path = preview_path_for(preview_name)
    temporary_path = PREVIEWS_DIR / f".{uuid.uuid4().hex}.glb"
    export_script = (
        "import bpy, os, sys\n"
        "source_path = os.path.abspath(sys.argv[-2])\n"
        "export_path = sys.argv[-1]\n"
        "result = bpy.ops.wm.open_mainfile(filepath=source_path)\n"
        "if 'FINISHED' not in result or os.path.normcase(os.path.abspath(bpy.data.filepath)) != os.path.normcase(source_path):\n"
        "    raise RuntimeError('O arquivo Blender não foi aberto completamente.')\n"
        "bpy.ops.export_scene.gltf(filepath=export_path, export_format='GLB')\n"
    )
    command = [
        str(blender),
        "--background",
        "--python-expr",
        export_script,
        "--",
        str(source),
        str(temporary_path),
    ]

    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode != 0 or not temporary_path.is_file():
            details = (result.stderr + result.stdout)[-2000:]
            logger.error("Falha ao exportar prévia de %s: %s", source.name, details)
            return False

        validate_model_file(temporary_path, ".glb")
        os.replace(temporary_path, preview_path)
        source_stat = source.stat()
        os.utime(preview_path, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        return True
    except (OSError, subprocess.TimeoutExpired, HTTPException) as error:
        logger.warning("Não foi possível criar a prévia de %s: %s", source.name, error)
        return False
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def has_blend_preview(source: Path) -> bool:
    preview = preview_path_for(source.name)
    return preview.is_file() and preview.stat().st_mtime_ns >= source.stat().st_mtime_ns


class GitHubImport(BaseModel):
    url: str


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def validate_model_file(path: Path, extension: str) -> None:
    with path.open("rb") as model_file:
        header = model_file.read(12)

    if extension == ".glb" and (
        len(header) < 12
        or header[:4] != b"glTF"
        or int.from_bytes(header[4:8], "little") != 2
        or int.from_bytes(header[8:12], "little") != path.stat().st_size
    ):
        raise HTTPException(status_code=400, detail="O arquivo não parece ser um GLB válido.")
    if extension.startswith(".blend"):
        blend_header = header
        try:
            if header[:2] == b"\x1f\x8b":
                with gzip.open(path, "rb") as compressed_file:
                    blend_header = compressed_file.read(12)
            elif header[:4] == b"\x28\xb5\x2f\xfd":
                with path.open("rb") as compressed_file:
                    with zstandard.ZstdDecompressor().stream_reader(compressed_file) as reader:
                        blend_header = reader.read(12)
        except (OSError, zstandard.ZstdError) as error:
            raise HTTPException(status_code=400, detail="Não foi possível descomprimir o projeto Blender.") from error
        if len(blend_header) < 12 or blend_header[:7] != b"BLENDER":
            raise HTTPException(status_code=400, detail="O arquivo não parece ser um projeto Blender válido.")


def github_raw_file(url: str) -> tuple[str, str]:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.query or parsed.fragment or parsed.username:
        raise HTTPException(status_code=400, detail="Use um link HTTPS direto de um arquivo público do GitHub.")

    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if parsed.hostname == "github.com" and len(parts) >= 5 and parts[2] == "blob":
        owner, repository, _, branch, *file_parts = parts
        if not file_parts:
            raise HTTPException(status_code=400, detail="O link do GitHub precisa apontar para um arquivo.")
        raw_path = "/".join(quote(part, safe="") for part in (owner, repository, branch, *file_parts))
        raw_url = f"https://raw.githubusercontent.com/{raw_path}"
        filename = file_parts[-1]
    elif parsed.hostname == "raw.githubusercontent.com" and len(parts) >= 4:
        raw_url = url
        filename = parts[-1]
    else:
        raise HTTPException(
            status_code=400,
            detail="Use um link de arquivo github.com/.../blob/... ou raw.githubusercontent.com.",
        )

    filename = Path(filename).name
    if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="O link precisa apontar para um arquivo .blend ou .glb.")
    return raw_url, filename


def read_github_sources() -> dict[str, dict[str, str | None]]:
    try:
        data = json.loads(GITHUB_SOURCES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_github_sources(sources: dict[str, dict[str, str | None]]) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=DATA_DIR, suffix=".tmp", delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(sources, temporary_file, ensure_ascii=True, indent=2)
        os.replace(temporary_path, GITHUB_SOURCES_FILE)
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def download_github_file(
    raw_url: str,
    filename: str,
    etag: str | None = None,
    last_modified: str | None = None,
) -> tuple[bool, str | None, str | None]:
    extension = Path(filename).suffix.lower()
    temporary_path = None
    size = 0
    headers = {"User-Agent": "Modelo-A3/1.0"}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    request = Request(raw_url, headers=headers)
    opener = build_opener(RejectRedirects())

    try:
        with opener.open(request, timeout=30) as response:
            if urlparse(response.geturl()).hostname != "raw.githubusercontent.com":
                raise HTTPException(status_code=400, detail="O GitHub redirecionou para um host não permitido.")
            response_etag = response.headers.get("ETag")
            response_modified = response.headers.get("Last-Modified")
            with tempfile.NamedTemporaryFile(dir=MODELS_DIR, suffix=".download", delete=False) as temporary_file:
                temporary_path = Path(temporary_file.name)
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_SIZE:
                        raise HTTPException(status_code=413, detail="O arquivo excede o limite de 250 MB.")
                    temporary_file.write(chunk)

        validate_model_file(temporary_path, extension)
        if extension.startswith(".blend") and not create_blend_preview(temporary_path, filename):
            raise HTTPException(
                status_code=422,
                detail="O Blender não conseguiu abrir este arquivo completo. Envie o projeto .blend original, não apenas o cabeçalho.",
            )
        destination = MODELS_DIR / filename
        os.replace(temporary_path, destination)
        return True, response_etag, response_modified
    except HTTPError as error:
        if error.code == 304:
            return False, etag, last_modified
        raise HTTPException(status_code=400, detail="Não foi possível baixar o arquivo público do GitHub.") from error
    except HTTPException:
        raise
    except (URLError, TimeoutError) as error:
        raise HTTPException(status_code=400, detail="Não foi possível baixar o arquivo público do GitHub.") from error
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def import_github_file(url: str) -> str:
    raw_url, filename = github_raw_file(url)
    _, etag, last_modified = download_github_file(raw_url, filename)
    with sources_lock:
        sources = read_github_sources()
        sources[filename] = {
            "url": raw_url,
            "etag": etag,
            "last_modified": last_modified,
        }
        write_github_sources(sources)
    return filename


def detach_github_source(filename: str) -> None:
    with sources_lock:
        sources = read_github_sources()
        if filename in sources:
            del sources[filename]
            write_github_sources(sources)


def refresh_github_sources() -> None:
    with sources_lock:
        sources = read_github_sources()

    for filename, source in sources.items():
        try:
            changed, etag, last_modified = download_github_file(
                source["url"], filename, source.get("etag"), source.get("last_modified")
            )
        except (HTTPException, KeyError, TypeError):
            logger.warning("Não foi possível atualizar o arquivo GitHub %s", filename)
            continue

        if changed or etag != source.get("etag") or last_modified != source.get("last_modified"):
            with sources_lock:
                current_sources = read_github_sources()
                current_source = current_sources.get(filename)
                if not current_source or current_source.get("url") != source.get("url"):
                    continue
                current_sources[filename] = {
                    "url": source["url"],
                    "etag": etag,
                    "last_modified": last_modified,
                }
                write_github_sources(current_sources)


def model_signature() -> tuple[tuple[str, int, int, int, int], ...]:
    entries = []
    for path in MODELS_DIR.iterdir():
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
            stat = path.stat()
            preview = preview_path_for(path.name) if path.suffix.lower().startswith(".blend") else path
            preview_stat = preview.stat() if preview.is_file() else None
            entries.append(
                (
                    path.name,
                    stat.st_mtime_ns,
                    stat.st_size,
                    preview_stat.st_mtime_ns if preview_stat else 0,
                    preview_stat.st_size if preview_stat else 0,
                )
            )
    return tuple(sorted(entries))


async def watch_models() -> None:
    for path in MODELS_DIR.iterdir():
        if path.is_file() and path.suffix.lower().startswith(".blend") and not has_blend_preview(path):
            await asyncio.to_thread(create_blend_preview, path)
    previous_signature = model_signature()
    next_github_check = 0.0
    while True:
        await asyncio.sleep(0.75)
        loop = asyncio.get_running_loop()
        if loop.time() >= next_github_check:
            try:
                await asyncio.to_thread(refresh_github_sources)
            except Exception:
                logger.exception("Erro ao atualizar links do GitHub")
            next_github_check = loop.time() + GITHUB_POLL_SECONDS
        current_signature = model_signature()
        if current_signature == previous_signature:
            continue
        previous_by_name = {entry[0]: entry[1:3] for entry in previous_signature}
        for entry in current_signature:
            path = MODELS_DIR / entry[0]
            if (
                path.suffix.lower().startswith(".blend")
                and previous_by_name.get(path.name) != entry[1:3]
                and not has_blend_preview(path)
            ):
                await asyncio.to_thread(create_blend_preview, path)
        current_signature = model_signature()
        previous_signature = current_signature
        stale_clients = []
        for client in connected_clients.copy():
            try:
                await client.send_json({"type": "models_changed"})
            except Exception:
                stale_clients.append(client)
        for client in stale_clients:
            connected_clients.discard(client)


@app.on_event("startup")
async def start_model_watcher() -> None:
    global watcher_task
    watcher_task = asyncio.create_task(watch_models())


@app.on_event("shutdown")
async def stop_model_watcher() -> None:
    if watcher_task:
        watcher_task.cancel()


@app.websocket("/ws")
async def model_updates(websocket: WebSocket) -> None:
    await websocket.accept()
    connected_clients.add(websocket)
    await websocket.send_json({"type": "models_changed"})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(websocket)


@app.get("/")
def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/models")
def list_models() -> list[dict[str, str | int | bool | None]]:
    models = []
    with sources_lock:
        linked_names = set(read_github_sources())
    for path in MODELS_DIR.iterdir():
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        stat = path.stat()
        extension = path.suffix.lower()
        source_version = f"{stat.st_mtime_ns}-{stat.st_size}"
        if extension == ".glb":
            previewable = True
            preview_url = f"/models/{quote(path.name, safe='')}"
            preview_stat = stat
        else:
            preview = preview_path_for(path.name)
            previewable = has_blend_preview(path)
            preview_url = f"/previews/{preview.name}" if previewable else None
            preview_stat = preview.stat() if previewable else None
        preview_version = (
            f"{preview_stat.st_mtime_ns}-{preview_stat.st_size}"
            if preview_stat
            else "unavailable"
        )
        models.append(
            {
                "name": path.name,
                "format": "BLEND" if extension.startswith(".blend") else "GLB",
                "previewable": previewable,
                "previewUrl": preview_url,
                "previewVersion": preview_version,
                "linked": path.name in linked_names,
                "size": stat.st_size,
                "updated": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).astimezone().isoformat(timespec="minutes"),
                "version": f"{source_version}-{preview_version}",
            }
        )
    return sorted(models, key=lambda model: str(model["name"]).casefold())


@app.post("/api/models")
async def upload_model(file: UploadFile = File(...)) -> dict[str, str | bool]:
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if not filename or extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Envie um arquivo .blend ou .glb.")

    destination = MODELS_DIR / filename
    temporary_path = None
    size = 0
    try:
        with tempfile.NamedTemporaryFile(
            dir=MODELS_DIR, suffix=".upload", delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail="O arquivo excede o limite de 250 MB.",
                    )
                temporary_file.write(chunk)

        validate_model_file(temporary_path, extension)
        previewable = extension == ".glb"
        if extension.startswith(".blend"):
            previewable = await asyncio.to_thread(create_blend_preview, temporary_path, filename)
            if not previewable:
                raise HTTPException(
                    status_code=422,
                    detail="O Blender não conseguiu abrir este arquivo completo. Envie o projeto .blend original, não apenas o cabeçalho.",
                )
        os.replace(temporary_path, destination)
        detach_github_source(filename)
        model_format = "BLEND" if extension.startswith(".blend") else "GLB"
        return {"name": filename, "format": model_format, "previewable": previewable, "message": "Modelo enviado com sucesso."}
    finally:
        await file.close()
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


@app.post("/api/github")
async def add_github_model(payload: GitHubImport) -> dict[str, str | bool]:
    filename = await asyncio.to_thread(import_github_file, payload.url)
    extension = Path(filename).suffix.lower()
    model_format = "BLEND" if extension.startswith(".blend") else "GLB"
    previewable = extension == ".glb" or has_blend_preview(MODELS_DIR / filename)
    return {"name": filename, "format": model_format, "previewable": previewable, "linked": True}


@app.delete("/api/models/{filename}")
def delete_model(filename: str) -> dict[str, str]:
    safe_filename = Path(filename).name
    if safe_filename != filename or Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Nome ou formato de arquivo inválido.")

    model_path = MODELS_DIR / safe_filename
    if not model_path.is_file():
        raise HTTPException(status_code=404, detail="O arquivo não está na biblioteca.")

    model_path.unlink()
    detach_github_source(safe_filename)
    if model_path.suffix.lower().startswith(".blend"):
        preview_path_for(safe_filename).unlink(missing_ok=True)
    return {"name": safe_filename, "message": "Arquivo removido da biblioteca."}