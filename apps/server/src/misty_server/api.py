from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, JsonValue

from misty_core import Actor, CommandRejected, Edit, Task, TaskState
from misty_store import TaskService


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


def create_app(service: TaskService, *, static_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="misty")

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

    if static_dir is not None and static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")

    return app
