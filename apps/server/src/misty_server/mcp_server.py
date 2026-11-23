"""Serve `misty_server.tools` to agents over MCP: at `/mcp` inside `misty serve`, and over
stdio as `misty mcp`. Both go through the same `TaskService` as the web UI.
"""

import json
import re
from importlib import metadata

import anyio
from mcp import types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.routing import BaseRoute

from misty_core import Actor, CommandRejected
from misty_server import tools
from misty_store import TaskService

PATH = "/mcp"

INSTRUCTIONS = """\
Misty is one person's task list, built around what makes tasks hard to start, not around \
project structure. You are editing their real tasks.

- Tasks form a tree: a task can have subtasks, to any depth.
- A task is open, done, released, or discarded. Released means let go on purpose, which is \
a legitimate outcome and never a failure. Discarded means captured by mistake or a \
duplicate, and is hidden.
- Every edit needs a `reason`. The user reads it in the task's history.
- Nothing is ever deleted, and any edit can be reversed with `undo_edit`.
- To restructure (break a task down, group tasks, split, merge, dissolve a parent), use \
`apply_edits`, so the change is made whole or not at all. Say in `reason` which task a \
new one came from.
- Completing or releasing a task leaves its subtasks as they are. Look at `open_children` \
in the result, and ask the user what to do with any that remain.
- A rejected edit changes nothing. The message says why, and usually what to do instead.
"""

# There is no auth, so `/mcp` only answers requests addressed to this machine by a
# loopback name, whatever interface the server is bound to. A page in the user's browser
# can't reach it by pointing another host name at 127.0.0.1 (DNS rebinding).
LOOPBACK_ONLY = TransportSecuritySettings(
    enable_dns_rebinding_protection=True,
    allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*"],
    allowed_origins=["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"],
)


def build_server(service: TaskService) -> Server:
    """An MCP server exposing every tool in `tools.TOOLS` against `service`."""

    async def list_tools(
        ctx: ServerRequestContext, params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name=tool.name,
                    description=tool.description,
                    input_schema=tool.input_schema,
                    annotations=types.ToolAnnotations(
                        read_only_hint=tool.read_only,
                        destructive_hint=False,  # nothing is deleted; every edit can be undone
                        open_world_hint=False,
                    ),
                )
                for tool in tools.TOOLS.values()
            ]
        )

    async def call_tool(
        ctx: ServerRequestContext, params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        actor = actor_for(ctx.session.client_params)
        try:
            # TaskService is synchronous (SQLite behind a lock): keep it off the event loop.
            result = await anyio.to_thread.run_sync(
                tools.call, service, params.name, params.arguments, actor
            )
        except CommandRejected as e:
            return _text(str(e), is_error=True)
        return _text(json.dumps(result, ensure_ascii=False))

    return Server(
        "misty",
        version=metadata.version("misty-server"),
        instructions=INSTRUCTIONS,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


def actor_for(client: types.InitializeRequestParams | None) -> Actor:
    """Who an MCP client's edits are recorded as: `agent:<the name it introduced itself by>`.

    Tools take no actor argument, so an agent can't record an edit as the user.
    """
    name = client.client_info.name if client else ""
    slug = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-")[:40]
    return Actor(kind="agent", id=f"agent:{slug or 'unknown'}")


def http_routes(server: Server) -> list[BaseRoute]:
    """Routes serving `server` at `/mcp` (Streamable HTTP), to add to the web app.

    The app must also run `server.session_manager.run()` for as long as it serves.
    """
    return list(
        server.streamable_http_app(
            streamable_http_path=PATH, transport_security=LOOPBACK_ONLY
        ).routes
    )


async def serve_stdio(service: TaskService) -> None:
    """Serve one client over this process's stdin and stdout, until it disconnects."""
    server = build_server(service)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def _text(text: str, *, is_error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)], is_error=is_error
    )
