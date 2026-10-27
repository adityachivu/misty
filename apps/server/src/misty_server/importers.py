"""One-off imports from other task sources into the edit log."""

import uuid
from typing import Any

from misty_core import Actor
from misty_store import TaskService

DARTBOARD_ACTOR = Actor(kind="system", id="import:dartboard")


def import_dartboard(service: TaskService, data: dict[str, Any]) -> int:
    """Import the task tree served by the Obsidian dartboard's GET /api/tasks.

    Records ordinary create_task/complete_task edits, all sharing one correlation id.
    Returns the number of tasks created.
    """
    correlation_id = f"import:{uuid.uuid7()}"
    count = 0

    def run(tool: str, args: dict[str, Any]) -> str | None:
        return service.execute(
            tool,
            args,
            actor=DARTBOARD_ACTOR,
            correlation_id=correlation_id,
            reason="Imported from the dartboard (Obsidian 850 Tasks)",
        ).task_id

    def add(task: dict[str, Any], parent_id: str | None) -> None:
        nonlocal count
        attrs: dict[str, Any] = {}
        if parent_id is None:
            attrs["category"] = task["category"]
            if task.get("section"):
                attrs["section"] = task["section"]
        if task.get("zap"):
            attrs["quick"] = True
        if task.get("date"):
            attrs["date"] = task["date"]
            attrs["date_kind"] = "scheduled" if task.get("dateType") == "scheduled" else "due"
        task_id = run(
            "create_task", {"title": task["text"], "parent_id": parent_id, "attrs": attrs}
        )
        assert task_id is not None
        count += 1
        if task.get("done"):
            run("complete_task", {"task_id": task_id})
        for child in task.get("children", []):
            add(child, task_id)

    for task in data["tasks"]:
        add(task, None)
    return count
