import {
  ArrowDown,
  AtSign,
  Bell,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Hash,
  History,
  Inbox,
  Menu,
  Plus,
  Reply,
  Send,
  Server,
  Settings,
  UserRound,
  Users,
  X,
} from "lucide-react";

const iconComponents = {
  arrowDown: ArrowDown,
  atSign: AtSign,
  bell: Bell,
  check: Check,
  chevronDown: ChevronDown,
  close: X,
  copy: Copy,
  eye: Eye,
  eyeOff: EyeOff,
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
  user: UserRound,
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
