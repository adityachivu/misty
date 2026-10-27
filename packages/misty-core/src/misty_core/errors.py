class CommandRejected(Exception):
    """A command is invalid against the current state. Nothing was written.

    The message is shown to whoever issued the command (often an agent), so it
    should say what was wrong and, where possible, what to do instead.
    """


class ReplayError(Exception):
    """A recorded edit could not be applied.

    This should never happen: edits are validated before they are recorded.
    It means a reducer or upcaster bug, and the replay invariant is broken.
    """
