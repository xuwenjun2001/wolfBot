"""Private bounded parser API. It accepts bytes, never URLs or filesystem paths."""
import asyncio
import hmac
import multiprocessing as mp
import os
import queue
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request

from adapter import digest, make_receipt, parser_identity
from worker import worker

app = FastAPI(docs_url=None, redoc_url=None)
MAX_ORIGINAL_BYTES = 50_000_000
jobs = {}
active = None
process = None
requests = responses = None


def authorize(authorization: str = Header(default="")):
    expected = os.getenv("DOCUMENT_PARSER_TOKEN", "")
    if not expected or not hmac.compare_digest(authorization, "Bearer " + expected):
        raise HTTPException(401, "Parser authorization required")


def start_worker():
    global process, requests, responses
    if process is not None and process.is_alive():
        return
    context = mp.get_context("spawn")
    requests, responses = context.Queue(), context.Queue()
    process = context.Process(target=worker, args=(requests, responses), daemon=True)
    process.start()


def stop_worker():
    global process
    if process is not None and process.is_alive():
        process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=2)
    process = None


@app.get("/health", dependencies=[Depends(authorize)])
def health():
    return {"parser": parser_identity(), "device": "cpu", "concurrency": 1}


async def execute(job_id, pdf_path, settings, original_sha):
    global active
    job = jobs[job_id]
    pages, failed, warnings, count = [], [], [], None
    started = time.monotonic()
    try:
        start_worker()
        requests.put((str(pdf_path), settings, parser_identity()["version"]))
        job["status"] = "running"
        while True:
            if job["cancel"] or time.monotonic() - started > settings["timeoutSeconds"]:
                warnings.append("cancelled_partial" if job["cancel"] else "timeout_partial")
                stop_worker()
                break
            if not process or not process.is_alive():
                warnings.append("worker_stopped_partial")
                break
            try:
                kind, value = await asyncio.to_thread(responses.get, True, .2)
            except queue.Empty:
                continue
            if kind == "count":
                count = value
            elif kind == "page":
                if len(value["text"]) > 500000 or sum(len(p["text"]) for p in pages) + len(value["text"]) > settings["maxCharacters"]:
                    warnings.append("character_limit_partial")
                    stop_worker()
                    break
                pages.append(value)
            elif kind == "failed":
                failed.append(value["page"])
                warnings.append(f"page_{value['page']}:{value['reason']}")
            elif kind == "error":
                warnings.append(value)
                stop_worker()
                break
            elif kind == "done":
                break
            job["completedPages"] = len(pages)
        if count is None:
            raise ValueError("Original page count unavailable")
        accounted = {p["filePage"] for p in pages} | set(failed)
        truncated = [n for n in range(1, count + 1) if n not in accounted]
        receipt = make_receipt(original_sha, count, pages, failed, truncated, warnings[:100])
        job.update(status="completed", result=receipt, elapsedMs=round((time.monotonic() - started) * 1000))
    except Exception as error:  # noqa: BLE001 - job boundary exposes an explicit terminal failure
        stop_worker()
        job.update(status="failed", error=type(error).__name__)
    finally:
        pdf_path.unlink(missing_ok=True)
        active = None


@app.post("/jobs", status_code=202, dependencies=[Depends(authorize)])
async def create_job(request: Request, maxPages: int = Query(500, ge=1, le=1000),
                     maxCharacters: int = Query(2000000, ge=100, le=5000000),
                     forceOcr: bool = False, timeoutSeconds: int = Query(180, ge=1, le=1200)):
    global active
    if active:
        raise HTTPException(429, "Parser busy")
    job_id = str(uuid.uuid4())
    active = job_id  # reserve before the first await, including during upload
    try:
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_ORIGINAL_BYTES:
                raise HTTPException(413, "Original exceeds 50 MB")
            data.extend(chunk)
        if not data.startswith(b"%PDF-"):
            raise HTTPException(415, "PDF bytes required")
        root = Path(os.environ["DOCUMENT_PARSER_CACHE"])
        root.mkdir(parents=True, exist_ok=True)
        pdf_path = root / (job_id + ".pdf")
        pdf_path.write_bytes(data)
        # Only 16 recent job responses in memory; page caches are versioned separately.
        while len(jobs) >= 16:
            del jobs[next(iter(jobs))]
        jobs[job_id] = {"status": "queued", "cancel": False, "completedPages": 0}
        settings = {"maxPages": maxPages, "maxCharacters": maxCharacters, "forceOcr": forceOcr, "timeoutSeconds": timeoutSeconds}
        asyncio.create_task(execute(job_id, pdf_path, settings, digest(bytes(data))))
        return {"jobId": job_id}
    except BaseException:
        active = None
        raise


@app.get("/jobs/{job_id}", dependencies=[Depends(authorize)])
def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    return jobs[job_id]


@app.delete("/jobs/{job_id}", dependencies=[Depends(authorize)])
def cancel_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    jobs[job_id]["cancel"] = True
    return {"status": "cancelling"}
