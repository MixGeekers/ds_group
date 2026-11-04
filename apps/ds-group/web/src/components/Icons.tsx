export type IconName = "gear" | "members" | "inbox" | "bell" | "file" | "menu";

export function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true">
      <use href={`#icon-${name}`} />
    </svg>
  );
}

export function IconsLibrary() {
  return (
    <svg
      className="icon-library"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <symbol id="icon-gear" viewBox="0 0 24 24">
        <path
          d="m9 3-1 3-3 1-2 4 2 2v3l3 2 1 3h5l1-3 3-2v-3l2-2-2-4-3-1-1-3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle
          cx="11.5"
          cy="12"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </symbol>
      <symbol id="icon-members" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3" fill="currentColor" />
        <path
          d="M3 20v-2a6 6 0 0 1 12 0v2ZM17 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="icon-inbox" viewBox="0 0 24 24">
        <path
          d="M4 4h16v16H4zM4 13h5l2 3h2l2-3h5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="icon-bell" viewBox="0 0 24 24">
        <path
          d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5Zm5 3h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="icon-file" viewBox="0 0 24 24">
        <path
          d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="icon-menu" viewBox="0 0 24 24">
        <path
          d="M4 6h16M4 12h16M4 18h16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </symbol>
    </svg>
  );
}
