import { FEATURE_NAMES, type Features } from "@contextlanes/protocol";

/** Every feature on: for tests of frozen features, and tests that use them as fixtures (ACP lanes, review). */
export const ALL_FEATURES = Object.fromEntries(FEATURE_NAMES.map((f) => [f, true])) as Features;
