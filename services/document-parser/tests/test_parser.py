import asyncio
import queue
from types import SimpleNamespace

import httpx
import pytest

import app as api
from adapter import normalize_box


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def isolated_parser(monkeypatch, tmp_path):
    monkeypatch.setenv("DOCUMENT_PARSER_TOKEN", "test-only")
    monkeypatch.setenv("DOCUMENT_PARSER_CACHE", str(tmp_path))
    monkeypatch.setattr(api, "jobs", {})
    monkeypatch.setattr(api, "active", None)
    monkeypatch.setattr(api, "process", None)
    monkeypatch.setattr(api, "parser_identity", lambda: {"name": "test", "version": "fixture"})
    monkeypatch.setattr(api, "requests", queue.Queue())
    monkeypatch.setattr(api, "responses", queue.Queue())

    def start():
        api.process = SimpleNamespace(is_alive=lambda: True)

    monkeypatch.setattr(api, "start_worker", start)
    monkeypatch.setattr(api, "stop_worker", lambda: setattr(api, "process", None))


def test_real_geometry_only():
    top = SimpleNamespace(l=10, r=50, t=20, b=60, coord_origin="TOPLEFT")
    bottom = SimpleNamespace(l=10, r=50, t=80, b=40, coord_origin="BOTTOMLEFT")
    assert normalize_box(top, 100, 100) == {"x0": .1, "y0": .2, "x1": .5, "y1": .6}
    assert normalize_box(bottom, 100, 100) == pytest.approx(normalize_box(top, 100, 100))
    top.r = 200
    assert normalize_box(top, 100, 100) is None
    assert normalize_box(None, 100, 100) is None


def page_one():
    return {"filePage": 1, "text": "金额 1.20 元", "blocks": [{"id": "b1", "order": 0, "kind": "text",
            "text": "金额 1.20 元", "locator": {"kind": "block", "blockId": "b1", "filePage": 1},
            "quality": "needs_review", "flags": ["ocr_requires_review"]}]}


async def terminal(client, job_id):
    for _ in range(150):
        job = (await client.get(f"/jobs/{job_id}")).json()
        if job["status"] in {"completed", "failed"}:
            return job
        await asyncio.sleep(.02)
    raise AssertionError("Job did not terminate")


@pytest.mark.anyio
async def test_scope_and_cancel_preserve_partial_and_free_slot(monkeypatch):
    monkeypatch.setattr(api, "make_receipt", lambda sha, count, pages, failed, truncated, warnings: {
        "pages": pages, "pageCount": count, "truncatedPages": truncated, "warnings": warnings, "status": "partial"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://parser", headers={"Authorization": "Bearer test-only"}) as client:
        assert (await client.get("/health", headers={"Authorization": ""})).status_code == 401
        assert (await client.post("/jobs", content=b"not a PDF")).status_code == 415
        assert (await client.post("/jobs?maxPages=1001", content=b"%PDF-fixture")).status_code == 422
        monkeypatch.setattr(api, "MAX_ORIGINAL_BYTES", 128)
        async def oversized():
            yield b"%PDF-" + b"x" * 80
            yield b"y" * 80
        assert (await client.post("/jobs", content=oversized())).status_code == 413
        assert api.active is None
        api.responses.put(("count", 2))
        api.responses.put(("page", page_one()))
        job_id = (await client.post("/jobs", content=b"%PDF-fixture")).json()["jobId"]
        for _ in range(50):
            if api.jobs[job_id]["completedPages"] == 1:
                break
            await asyncio.sleep(.02)
        assert (await client.post("/jobs", content=b"%PDF-fixture")).status_code == 429
        assert (await client.delete(f"/jobs/{job_id}")).status_code == 200
        job = await terminal(client, job_id)
        assert job["result"]["pages"] == [page_one()]
        assert job["result"]["truncatedPages"] == [2]
        assert job["result"]["warnings"] == ["cancelled_partial"]
        assert api.active is None
        assert (await client.get("/jobs/not-a-job")).status_code == 404


@pytest.mark.anyio
async def test_timeout_is_terminal_and_retains_finished_pages(monkeypatch):
    monkeypatch.setattr(api, "make_receipt", lambda sha, count, pages, failed, truncated, warnings: {"pages": pages, "warnings": warnings})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://parser", headers={"Authorization": "Bearer test-only"}) as client:
        api.responses.put(("count", 2))
        api.responses.put(("page", page_one()))
        job_id = (await client.post("/jobs?timeoutSeconds=1", content=b"%PDF-fixture")).json()["jobId"]
        job = await terminal(client, job_id)
        assert job["result"]["pages"] == [page_one()]
        assert job["result"]["warnings"] == ["timeout_partial"]
        assert api.active is None


@pytest.mark.anyio
async def test_native_first_still_accounts_for_unprocessed_and_character_limited_pages(monkeypatch):
    monkeypatch.setattr(api, "make_receipt", lambda sha, count, pages, failed, truncated, warnings: {
        "originalSha256": sha, "pageCount": count, "pages": pages, "failedPages": failed,
        "truncatedPages": truncated, "warnings": warnings, "status": "partial"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://parser", headers={"Authorization": "Bearer test-only"}) as client:
        api.responses.put(("count", 3))
        api.responses.put(("page", page_one()))
        api.responses.put(("page", {"filePage": 2, "text": "x" * 101, "blocks": []}))
        job_id = (await client.post("/jobs?preferNative=true&maxPages=2&maxCharacters=100", content=b"%PDF-fixture")).json()["jobId"]
        job = await terminal(client, job_id)
        assert api.requests.get_nowait()[1]["preferNative"] is True
        assert job["result"]["pages"] == [page_one()]
        assert job["result"]["truncatedPages"] == [2, 3]
        assert job["result"]["warnings"] == ["pdfium_native_text_has_no_table_grid", "character_limit_partial"]
        assert api.active is None
