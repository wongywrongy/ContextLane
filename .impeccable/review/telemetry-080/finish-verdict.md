## verdict

1. Mobile disclosure row — resolved. The refreshed `agent-list-390.png` shows compact avatar/name/metadata/pill/context groups with no orphaned chevrons or extra disclosure row. Desktop/tablet captures retain correctly sized trailing chevrons. Current supplied browser evidence includes 360px and reports no overflow.
2. Design persistence — resolved. DESIGN.md now documents Rootlane 0.8.0 flat sections, shared label/value/aside rows, 6px meters, 34px telemetry avatars/rings, agent list/detail, read-only telemetry setup and mobile reflow. Contradictory card guidance was removed; `.impeccable/design.json` carries the updated title, narrative and flat-section/meter/agent-row components.

All 20 current captures were reopened and retain valid named dimensions and content. No regressions introduced by this fix batch were observed.

## remaining

Clear. This ship verdict covers the two scored fixes; the prior whole-surface review remains the design assessment.

Skipped new issue hunting and live-host acceptance; the browser evidence uses disclosed synthetic fixtures.

disposition: ship
