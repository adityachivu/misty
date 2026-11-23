"""Registry of task attributes: the experimental cognitive/somatic dimensions.

Attributes live in `Task.attrs`, so adding one is a single `register(...)` call:
no migration, no new edit type, no new tool.

Validation happens only when a command is decided, never during replay. Removing
or retyping an attribute here therefore never breaks old history. Write an
upcaster (`misty_core.upcasters`) if old values should be renamed or converted.

Keys starting with `x_` are accepted as any JSON value, for quick experiments
before an attribute earns a proper spec.
"""

import datetime as dt
import json
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import JsonValue, TypeAdapter, ValidationError

from misty_core.errors import CommandRejected

EXPERIMENTAL_PREFIX = "x_"


@dataclass(frozen=True)
class AttributeSpec:
    key: str
    type: Any  # anything pydantic can validate, e.g. str, Annotated[int, Field(ge=1, le=5)]
    description: str
    adapter: TypeAdapter[Any] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "adapter", TypeAdapter(self.type))

    def validate(self, value: Any) -> JsonValue:
        return self.adapter.dump_python(self.adapter.validate_python(value), mode="json")


ATTRIBUTES: dict[str, AttributeSpec] = {}


def register(spec: AttributeSpec) -> None:
    if spec.key.startswith(EXPERIMENTAL_PREFIX):
        raise ValueError(f"{EXPERIMENTAL_PREFIX!r} keys are reserved for unregistered experiments")
    ATTRIBUTES[spec.key] = spec


register(AttributeSpec("notes", str, "Free-form notes about the task."))

# Used by the dartboard view. They mirror the Obsidian task format the dartboard
# started from, and are placeholders until the cognitive/somatic research settles.
register(
    AttributeSpec(
        "category",
        Literal["work", "uni", "projects", "admin"],
        "Life area. The dartboard draws one quadrant per category.",
    )
)
register(AttributeSpec("section", str, "Heading the task is grouped under within its category."))
register(AttributeSpec("quick", bool, "A quick task: about 15 minutes or less."))
register(
    AttributeSpec("date", dt.date, "The task's date, as YYYY-MM-DD. See date_kind for its meaning.")
)
register(
    AttributeSpec(
        "date_kind",
        Literal["due", "scheduled"],
        "Whether `date` is a deadline (due) or an intention to do it then (scheduled).",
    )
)


_ANY_JSON = TypeAdapter[JsonValue](JsonValue)


def json_schema() -> dict[str, Any]:
    """JSON Schema for a task's `attrs`: each registered attribute, plus `x_` experiments.

    Tool listings are built from this, so agents learn the attributes from the registry.
    """
    return {
        "type": "object",
        "properties": {
            key: {**spec.adapter.json_schema(), "description": spec.description}
            for key, spec in ATTRIBUTES.items()
        },
        "patternProperties": {f"^{EXPERIMENTAL_PREFIX}": {}},
        "additionalProperties": False,
    }


def validate_attrs(attrs: dict[str, Any]) -> dict[str, JsonValue]:
    """Validate and normalise attribute values. Raises CommandRejected."""
    result: dict[str, JsonValue] = {}
    for key, value in attrs.items():
        if value is None:
            raise CommandRejected(f"Attribute {key!r} is null; use unset_attributes to remove it")
        spec = ATTRIBUTES.get(key)
        try:
            if spec is not None:
                result[key] = spec.validate(value)
            elif key.startswith(EXPERIMENTAL_PREFIX):
                result[key] = _ANY_JSON.validate_python(value)
            else:
                known = ", ".join(sorted(ATTRIBUTES)) or "none"
                raise CommandRejected(
                    f"Unknown attribute {key!r}. Known attributes: {known}. "
                    f"Prefix experimental keys with {EXPERIMENTAL_PREFIX!r}."
                )
        except ValidationError as e:
            raise CommandRejected(
                f"Invalid value for attribute {key!r}: {e.errors()[0]['msg']}"
            ) from e
    return result


def same_value(a: JsonValue, b: JsonValue) -> bool:
    """JSON equality: unlike `==`, keeps True distinct from 1, and 1 from 1.0."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
