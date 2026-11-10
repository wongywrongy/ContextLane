import { createElement, useEffect, type ReactNode } from "react";
import { Navigate } from "react-router";
import { create } from "zustand";
import { FEATURE_NAMES, type Feature, type Features } from "@contextlanes/protocol";
import { getJson } from "./api";

/** Core pages, always shown. */
export const READY = { run: true } as const;

const NONE = Object.fromEntries(FEATURE_NAMES.map((f) => [f, false])) as Features;

type FeatureStore = { features: Features | null; failed: boolean; load: () => void };

/**
 * Which features outside the core the owner turned on ([features] in config), fetched once for the whole
 * app. They change only when the daemon restarts, which reloads the page anyway.
 */
export const useFeatureStore = create<FeatureStore>((set, get) => ({
  features: null,
  failed: false,
  load: () => {
    if (get().features) return;
    getJson<Features>("/api/features").then((features) => set({ features, failed: false }), () => set({ failed: true }));
  },
}));

function useLoaded(): FeatureStore {
  const store = useFeatureStore();
  useEffect(() => { store.load(); }, [store]);
  return store;
}

/** Until the daemon answers, everything optional stays hidden: a tab never appears and then vanishes. */
export function useFeatures(): Features {
  return useLoaded().features ?? NONE;
}

/** A page that belongs to a feature: shown when it is on, otherwise back to Work. */
export function Gate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const { features, failed } = useLoaded();
  if (!features && !failed) return null;
  return features?.[feature] ? children : createElement(Navigate, { to: "../work", replace: true });
}
