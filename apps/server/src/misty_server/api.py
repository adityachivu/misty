import asyncio
import contextlib
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, JsonValue

from misty_core import Actor, CommandRejected, Edit, Task, TaskState
from misty_core.structure import Step, Structure
from misty_store import Draft, DraftService, DraftStatus, TaskService
from misty_store.drafts import DEFAULT_SETTLE_MS


class CommandRequest(BaseModel):
    tool: str = Field(description="Edit to run, e.g. create_task.")
    args: dict[str, JsonValue] = Field(default_factory=dict)
    actor_id: str = Field(default="web", description="Which UI sent this, e.g. web:dartboard.")
    reason: str | None = None
    correlation_id: str | None = None


class TasksResponse(BaseModel):
    head_seq: int
    tasks: list[Task]


class EditResponse(BaseModel):
    edit: Edit


class DraftCreate(BaseModel):
    client: str = Field(description="Who is drafting, e.g. web:dartboard.")
    vocabulary: str = Field(description="What this client's ops mean, for the translator.")
    note: str | None = None
    settle_ms: int = Field(default=DEFAULT_SETTLE_MS, ge=0)


class DraftUpdate(BaseModel):
    append_ops: list[JsonValue] = Field(default_factory=list)
    after: Structure | None = Field(default=None, description="Replaces the intended structure.")
    note: str | None = None
    hold_ms: int | None = Field(
        default=None, ge=0, description="Don't settle for this long (a lease); 0 releases it."
    )


class StepIn(BaseModel):
    tool: str
    args: dict[str, JsonValue] = Field(default_factory=dict)
    as_: str | None = Field(default=None, alias="as")


class DraftApply(BaseModel):
    steps: list[StepIn] | None = Field(
        default=None,
        description="Commands composed by a translator (the agent). Omit to use the stand-in.",
    )
    translator: str | None = None


class DraftResponse(BaseModel):
    draft: Draft
    edits: list[Edit] = Field(default_factory=list)


def create_app(
    service: TaskService,
    *,
    static_dir: Path | None = None,
    settle_every: float | None = 1.0,
) -> FastAPI:
    """`settle_every`: seconds between checks for settled drafts; None disables it."""
    drafts = DraftService(service)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        async def settle_loop() -> None:
            assert settle_every is not None
            while True:
                await asyncio.sleep(settle_every)
                await asyncio.to_thread(drafts.settle_due)

        task = asyncio.create_task(settle_loop()) if settle_every else None
        yield
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="misty", lifespan=lifespan)
    app.state.drafts = drafts

    def draft_response(draft: Draft) -> DraftResponse:
        edits = [
            e for seq in draft.seqs or [] for e in service.edits(after_seq=seq - 1, upto_seq=seq)
        ]
        return DraftResponse(draft=draft, edits=edits)

    def rejected(e: CommandRejected) -> HTTPException:
        return HTTPException(status_code=400, detail=str(e))

    @app.get("/api/tasks")
    def list_tasks(state: Annotated[list[TaskState] | None, Query()] = None) -> TasksResponse:
        return TasksResponse(head_seq=service.head_seq(), tasks=service.list_tasks(state))

    @app.get("/api/tasks/{task_id}/history")
    def task_history(task_id: str) -> list[Edit]:
        return service.history(task_id)

    @app.get("/api/edits")
    def edits(after_seq: int = 0) -> list[Edit]:
        return service.edits(after_seq=after_seq)

    @app.post("/api/commands", responses={400: {"description": "Command rejected"}})
    def run_command(req: CommandRequest) -> EditResponse:
        """The UI write path: the same TaskService.execute that MCP tools will use."""
        try:
            edit = service.execute(
                req.tool,
                req.args,
                actor=Actor(kind="user", id=req.actor_id),
                reason=req.reason,
                correlation_id=req.correlation_id,
            )
        except CommandRejected as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return EditResponse(edit=edit)

    @app.get("/api/drafts")
    def list_drafts(status: DraftStatus | None = None) -> list[Draft]:
        """Drafts, oldest first. Open ones are reorganisations still settling."""
        return drafts.list_drafts(status)

    @app.post("/api/drafts", responses={400: {"description": "Rejected"}})
    def create_draft(req: DraftCreate) -> DraftResponse:
        draft = drafts.create(
            client=req.client, vocabulary=req.vocabulary, note=req.note, settle_ms=req.settle_ms
        )
        return DraftResponse(draft=draft)

    @app.get("/api/drafts/{draft_id}")
    def get_draft(draft_id: str) -> DraftResponse:
        draft = drafts.get(draft_id)
        if draft is None:
            raise HTTPException(status_code=404, detail=f"No draft {draft_id!r}")
        return draft_response(draft)

    @app.patch("/api/drafts/{draft_id}", responses={400: {"description": "Rejected"}})
    def update_draft(draft_id: str, req: DraftUpdate) -> DraftResponse:
        try:
            draft = drafts.update(
                draft_id,
                append_ops=req.append_ops,
                after=req.after,
                note=req.note,
                hold_ms=req.hold_ms,
            )
        except CommandRejected as e:
            raise rejected(e) from e
        return DraftResponse(draft=draft)

    @app.post("/api/drafts/{draft_id}/apply", responses={400: {"description": "Rejected"}})
    def apply_draft(draft_id: str, req: DraftApply | None = None) -> DraftResponse:
        """Apply now. A rejected draft comes back with status `rejected` and its `error`."""
        req = req or DraftApply()
        kwargs: dict[str, Any] = {}
        if req.steps is not None:
            kwargs["steps"] = [Step(s.tool, dict(s.args), s.as_) for s in req.steps]
        if req.translator:
            kwargs["translator"] = req.translator
        try:
            draft = drafts.apply(draft_id, **kwargs)
        except CommandRejected as e:
            raise rejected(e) from e
        return draft_response(draft)

    @app.post("/api/drafts/{draft_id}/discard", responses={400: {"description": "Rejected"}})
    def discard_draft(draft_id: str) -> DraftResponse:
        try:
            return DraftResponse(draft=drafts.discard(draft_id))
        except CommandRejected as e:
            raise rejected(e) from e

    if static_dir is not None and static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")

    return app
