from misty_server.seed import seed
from misty_store import TaskService, connect


def titles(service):
    return [(t.title, t.state, t.attrs.get("date")) for t in service.list_tasks()]


def test_seed_is_valid_and_repeatable():
    a, b = TaskService(connect(":memory:")), TaskService(connect(":memory:"))
    assert seed(a, n=15, rng_seed=7) == seed(b, n=15, rng_seed=7)
    assert titles(a) == titles(b)
    roots = [t for t in a.list_tasks() if t.parent_id is None]
    assert len(roots) == 15
    assert all(t.attrs["category"] in {"work", "uni", "projects", "admin"} for t in roots)
    assert a.verify() == []
