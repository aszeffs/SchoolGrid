# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Implementation status

Triage answers "should someone work on this". It does not answer "how far has
the work got", and a ticket picked up by an agent needs both. These strings go
in the same `Status:` line, replacing the triage role once work starts:

| Status              | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `in-progress`       | Work has started; some acceptance criteria are ticked and some are not   |
| `blocked-on-owner`  | Everything an agent can do is done; a remaining step needs a human       |
| `done`              | Every acceptance criterion is ticked, with evidence in `## Comments`     |

`blocked-on-owner` is distinct from `ready-for-human`. `ready-for-human` means
nobody has started because the whole ticket needs a person; `blocked-on-owner`
means the work is done except for something only the account holder can do,
such as registering a key or changing an organisation setting.
