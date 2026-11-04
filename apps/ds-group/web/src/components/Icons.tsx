import {
  ArrowDown,
  AtSign,
  Bell,
  ChevronDown,
  Copy,
  Hash,
  History,
  Inbox,
  Menu,
  Plus,
  Reply,
  Send,
  Server,
  Settings,
  Users,
  X,
} from "lucide-react";

const iconComponents = {
  arrowDown: ArrowDown,
  atSign: AtSign,
  bell: Bell,
  chevronDown: ChevronDown,
  close: X,
  copy: Copy,
  gear: Settings,
  hash: Hash,
  history: History,
  inbox: Inbox,
  members: Users,
  menu: Menu,
  plus: Plus,
  reply: Reply,
  send: Send,
  server: Server,
};

export type IconName = keyof typeof iconComponents;

export function Icon({ name }: { name: IconName }) {
  const Component = iconComponents[name];
  return (
    <Component
      className="icon"
      size={20}
      strokeWidth={2}
      color="currentColor"
      aria-hidden="true"
      focusable="false"
    />
  );
}
