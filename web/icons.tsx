import React from 'react';
const paths = {
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  agents: 'M16 21v-4a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v4M20 21v-4a4 4 0 0 0-3-4M12 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0M16 2a4 4 0 0 1 0 8',
  services:
    'M5 3h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2ZM7 6h.01M7 17h.01M12 6h5M12 17h5',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  link: 'M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-3 3M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l3-3',
  external: 'M15 3h6v6M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
  logs: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 12h8M8 16h8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  branch: 'M6 6v12M6 18c0-6 12-2 12-12M9 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 21a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  chevron: 'm6 9 6 6 6-6',
  refresh: 'M20 7a9 9 0 1 0 1 7M20 3v5h-5',
  moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10',
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Logo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 44" className="logo">
      <path d="m20 2 17 9v22l-17 9L3 33V11Z" fill="#12213b" stroke="#6387ff" strokeWidth="2" />
      <path d="m5 12 15 8v19L5 32Z" fill="#3159ff" />
      <path d="m20 20 15-8v20l-15 7Z" fill="#0b1525" />
    </svg>
  );
}
