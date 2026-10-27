import pytest

from misty_store import TaskService, connect


@pytest.fixture
def service():
    svc = TaskService(connect(":memory:"))
    yield svc
    svc.close()
