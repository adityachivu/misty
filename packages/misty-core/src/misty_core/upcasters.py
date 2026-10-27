"""Upgrade old edit payloads to the current shape when the log is read.

The stored log is never rewritten. When an edit type's payload changes, bump
its `version` and register an upcaster from the old (type, version):

    def _created_v1(payload):
        return "task.created", 2, {**payload, "attrs": payload.get("attrs", {})}

    UPCASTERS[("task.created", 1)] = _created_v1

An upcaster may also rename the type. Upcasters chain until no more match.
"""

from collections.abc import Callable
from typing import Any

type Upcaster = Callable[[dict[str, Any]], tuple[str, int, dict[str, Any]]]

UPCASTERS: dict[tuple[str, int], Upcaster] = {}


def upcast(type_: str, version: int, payload: dict[str, Any]) -> tuple[str, int, dict[str, Any]]:
    while (type_, version) in UPCASTERS:
        type_, version, payload = UPCASTERS[(type_, version)](payload)
    if type_ == "edit.reverted":
        # Reverts embed other edits' payloads, which need upgrading too.
        payload = {**payload, "ops": [_upcast_op(op) for op in payload["ops"]]}
    return type_, version, payload


def _upcast_op(op: dict[str, Any]) -> dict[str, Any]:
    type_, version, payload = upcast(op["type"], op["type_version"], op["payload"])
    return {"type": type_, "type_version": version, "payload": payload}
