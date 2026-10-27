"""Random but plausible test data, recorded as ordinary edits."""

import datetime as dt
import random
from typing import Any

from misty_core import Actor
from misty_store import TaskService

SEED_ACTOR = Actor(kind="system", id="seed")

TITLES: dict[str, dict[str, list[str]]] = {
    "work": {
        "Alerts": ["understand evaluations", "tune alert thresholds", "write incident summary"],
        "Platform": ["migrate CI runners", "review infra PR", "rotate API keys", "update runbook"],
        "People": ["prep 1:1 notes", "reply to recruiter", "plan team offsite"],
    },
    "uni": {
        "Deep Generative Models": ["plan exam prep", "finish problem set 3", "reread VAE paper"],
        "Thesis": ["draft related work", "email supervisor", "fix figure 2"],
    },
    "projects": {
        "Side projects": ["gemma 4 project", "catanatron dev", "graphene migration push"],
        "Applications": ["fellowship essay", "update CV", "ask for reference letter"],
    },
    "admin": {
        "Home": ["fix the tap", "buy new bedding", "book boiler service", "declutter desk"],
        "Money": ["file taxes", "cancel unused subscription", "pay rent"],
        "Health": ["book dentist", "refill prescription", "call the GP"],
    },
}

SUBTASKS = [
    "find the form",
    "write a rough outline",
    "send one email",
    "make a plan",
    "gather links",
    "do the first 10 minutes",
    "ask for help",
    "block time for it",
    "check the deadline",
    "set up the folder",
    "draft",
    "review",
    "tidy up",
]

# (weight, days from today or None for undated, date_kind)
DATES: list[tuple[int, int | None, str]] = [
    (2, -3, "due"),
    (2, -1, "due"),
    (5, 0, "due"),
    (3, 1, "due"),
    (3, 3, "due"),
    (3, 12, "due"),
    (2, 45, "due"),
    (4, None, "due"),
    (3, 20, "scheduled"),
]


def seed(service: TaskService, *, n: int = 20, rng_seed: int | None = None) -> int:
    """Create about `n` root tasks with subtasks. Returns the number of tasks created."""
    rng = random.Random(rng_seed)
    today = dt.date.today()
    count = 0

    def run(tool: str, args: dict[str, Any]) -> str:
        task_id = service.execute(tool, args, actor=SEED_ACTOR, correlation_id="seed").task_id
        assert task_id is not None
        return task_id

    def create(title: str, parent_id: str | None, attrs: dict[str, Any]) -> str:
        nonlocal count
        if rng.random() < 0.2:
            attrs["quick"] = True
        count += 1
        return run("create_task", {"title": title, "parent_id": parent_id, "attrs": attrs})

    pool = [
        (category, section, title)
        for category, sections in TITLES.items()
        for section, titles in sections.items()
        for title in titles
    ]
    for category, section, title in rng.sample(pool, min(n, len(pool))):
        attrs: dict[str, Any] = {"category": category, "section": section}
        (_, offset, kind) = rng.choices(DATES, weights=[w for w, _, _ in DATES])[0]
        if offset is not None:
            attrs["date"] = (today + dt.timedelta(days=offset)).isoformat()
            attrs["date_kind"] = kind
        root = create(title, None, attrs)
        # about half the tasks are already broken down, a few two levels deep
        for sub in rng.sample(SUBTASKS, rng.choice([0, 0, 0, 2, 3, 4])):
            child = create(sub, root, {})
            if rng.random() < 0.3:
                run("complete_task", {"task_id": child})
            elif rng.random() < 0.2:
                for subsub in rng.sample(SUBTASKS, 2):
                    create(subsub, child, {})
    return count
