"""The tools as an agent reaches them: through an MCP client, and at /mcp over HTTP."""

import json

import pytest
from fastapi.testclient import TestClient
from mcp import Client, types

from misty_core import Actor
from misty_server import tools
from misty_server.api import create_app
from misty_server.mcp_server import actor_for, build_server
from misty_store import TaskService, connect

INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "pytest", "version": "0"},
    },
}
MCP_HEADERS = {"accept": "application/json, text/event-stream"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def service():
    svc = TaskService(connect(":memory:"))
    yield svc
    svc.close()


def connect_as(service: TaskService, name: str = "Claude Code") -> Client:
    return Client(build_server(service), client_info=types.Implementation(name=name, version="1"))


def body(result: types.CallToolResult):
    [content] = result.content
    assert isinstance(content, types.TextContent)
    return content.text


@pytest.mark.anyio
async def test_lists_every_tool_with_its_schema_and_hints(service):
    async with connect_as(service) as client:
        listed = {tool.name: tool for tool in (await client.list_tools()).tools}
        assert "release" in (client.instructions or "")
    assert listed.keys() == tools.TOOLS.keys()
    for name, tool in listed.items():
        assert tool.input_schema == tools.TOOLS[name].input_schema
        assert tool.description == tools.TOOLS[name].description
        assert tool.annotations is not None
        assert tool.annotations.read_only_hint is tools.TOOLS[name].read_only
        assert tool.annotations.destructive_hint is False


@pytest.mark.anyio
async def test_edits_are_recorded_as_the_connected_agent(service):
    async with connect_as(service, "Claude Code") as client:
        result = await client.call_tool(
            "create_task", {"title": "Call the GP", "reason": "Came up in check-in"}
        )
    assert not result.is_error
    created = json.loads(body(result))
    assert created["seq"] == 1 and created["task"]["open_children"] == 0
    [edit] = service.edits()
    assert edit.actor == Actor(kind="agent", id="agent:claude-code")
    assert edit.reason == "Came up in check-in"
    assert service.verify() == []


@pytest.mark.anyio
async def test_a_rejection_is_an_error_result_and_writes_nothing(service):
    async with connect_as(service) as client:
        no_reason = await client.call_tool("create_task", {"title": "A"})
        bad_attr = await client.call_tool(
            "create_task", {"title": "A", "attrs": {"priority": 1}, "reason": "x"}
        )
        unknown = await client.call_tool("drop_table", {})
        listed = await client.call_tool("list_tasks", {})
    assert no_reason.is_error and "`reason` is required" in body(no_reason)
    assert bad_attr.is_error and "Unknown attribute 'priority'" in body(bad_attr)
    assert unknown.is_error and "Unknown tool" in body(unknown)
    assert not listed.is_error and json.loads(body(listed))["tasks"] == []
    assert service.head_seq() == 0


@pytest.mark.parametrize(
    ("name", "actor_id"),
    [
        ("Claude Code", "agent:claude-code"),
        ("misty-agent/0.1", "agent:misty-agent-0.1"),
        ("  ", "agent:unknown"),
        ("x" * 80, "agent:" + "x" * 40),
    ],
)
def test_actor_comes_from_the_client_name(name, actor_id):
    client = types.InitializeRequestParams(
        protocol_version="2025-06-18",
        capabilities=types.ClientCapabilities(),
        client_info=types.Implementation(name=name, version="1"),
    )
    assert actor_for(client) == Actor(kind="agent", id=actor_id)


def test_actor_is_never_the_user():
    assert actor_for(None) == Actor(kind="agent", id="agent:unknown")
    for tool in tools.TOOLS.values():
        assert not {"actor", "actor_id", "actor_kind"} & tool.input_schema["properties"].keys()


def test_mcp_is_served_beside_the_rest_api(service):
    with TestClient(create_app(service), base_url="http://127.0.0.1:4322") as client:
        response = client.post("/mcp", json=INITIALIZE, headers=MCP_HEADERS)
        assert response.status_code == 200
        assert '"name":"misty"' in response.text.replace(" ", "")
        assert client.get("/api/tasks").json() == {"head_seq": 0, "tasks": []}


def test_mcp_only_answers_to_a_loopback_host_name(service):
    with TestClient(create_app(service), base_url="http://misty.example") as client:
        assert client.post("/mcp", json=INITIALIZE, headers=MCP_HEADERS).status_code == 421
        assert client.get("/api/tasks").status_code == 200  # the REST API is as it was

    with TestClient(create_app(service), base_url="http://127.0.0.1:4322") as client:
        response = client.post(
            "/mcp", json=INITIALIZE, headers={**MCP_HEADERS, "origin": "https://misty.example"}
        )
        assert response.status_code == 403
