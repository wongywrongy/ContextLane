import React from 'react';

export function PanelSection({ title, aside, children, className = '' }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`psec ${className}`}><div className="psec-h"><h3>{title}</h3>{aside && <span className="psec-aside">{aside}</span>}</div>{children}</section>;
}

export function DetailRow({ label, value, aside }: { label: React.ReactNode; value: React.ReactNode; aside?: React.ReactNode }) {
  return <div className="dl"><div className="dl-label">{label}</div><div className="dl-value">{value}</div>{aside && <div className="dl-aside">{aside}</div>}</div>;
}

export const meterTone = (value: number) => value > 85 ? 'bad' : value >= 60 ? 'warn' : 'ok';
export function Meter({ value, segments }: { value: number; segments?: [number, number, number] }) {
  const pct = Math.min(100, Math.max(0, value));
  const total = segments?.reduce((sum, n) => sum + Math.max(0, n), 0) || 1;
  const widths = segments?.map(n => pct * Math.max(0, n) / total);
  return <div className={`bar ${meterTone(pct)}${widths ? ' context-bar' : ''}`} role="meter" aria-label={widths ? 'Context usage' : 'Usage'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">{widths ? widths.map((width, i) => <rect key={i} className={`bar-segment segment-${i}`} x={widths.slice(0, i).reduce((sum, n) => sum + n, 0)} y="0" width={width} height="6"/>) : <rect width={pct} height="6"/>}</svg></div>;
}
