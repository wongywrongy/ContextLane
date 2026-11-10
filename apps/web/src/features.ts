import { createElement, type ReactNode } from "react";
import { Navigate } from "react-router";
import { FEATURE_NAMES, type Feature, type Features } from "@contextlanes/protocol";
import { useJson } from "./api";

/** Core pages, always shown. */
export const READY = { run: true } as const;

const NONE = Object.fromEntries(FEATURE_NAMES.map((f) => [f, false])) as Features;

/**
 * Which features outside the core the owner turned on ([features] in config). Until the daemon answers,
 * everything optional stays hidden: a tab never appears and then vanishes.
 */
export function useFeatures(): Features {
  const [features] = useJson<Features>("/api/features");
  return features ?? NONE;
}

/** A page that belongs to a feature: shown when it is on, otherwise back to Work. */
export function Gate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const [features, error] = useJson<Features>("/api/features");
  if (!features && !error) return null;
  return features?.[feature] ? children : createElement(Navigate, { to: "../work", replace: true });
}
