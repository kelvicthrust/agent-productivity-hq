# Design revision history

The [current design brief](../../../DESIGN.md) and [canonical tokens](../../../design-system/DESIGN.md)
define the maintained design. The following revisions record earlier decisions and their evidence.

| Revision | Design decisions and verification limits                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2       | Retained the analytical hierarchy and introduced a playful, warm visual direction with cream surfaces, a single action color, small crew illustrations and restrained motion. Provider token totals include each category once.                                                     |
| D3       | Approved the D2 direction, a Monday-start This week default, system-rounded display text where available and a light-only design. Approval covered design intent.                                                                                                                   |
| D4       | Refined phone navigation and containment, provider accounting, coverage and refresh recovery, and recognizable session identity. The owner approved the revised screens as design. The design author did not run a browser comparison.                                              |
| D5       | Gave Usage links the same evidence badges as Delivery and replaced squeezed phone columns with session cards. Assistive-technology semantics of the resulting layout were unverified.                                                                                               |
| D6       | Fixed a prototype CSS specificity issue that duplicated provider, model and time on phone session cards. The author checked the source.                                                                                                                                             |
| D7       | Prevented desktop data-cell wrapping, aligned token totals, fixed plural labels, standardized Started, added a repeated Retry failure and filled the whole phone repository row. The author checked the source, with rendered behavior and real time-field meaning carried forward. |
| D8       | Chose **Needs a password** and **Not running** for the two unavailable Paseo states and specified helper text and Setup criteria. The source changes were read against those criteria.                                                                                              |
| D9       | Adopted Cozy Logbook, Refined, with sparklines and a clearer page hierarchy. The [token contract](../../../design-system/DESIGN.md) describes the revision.                                                                                                                         |

The [design research](research.md) records the inputs. The
[delivery build record](../delivery/build-record.md) captures separate implementation findings.
