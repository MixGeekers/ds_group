import {
  ArrowDown,
  ArrowLeft,
  AtSign,
  Bell,
  Bot,
  Briefcase,
  Check,
  ChevronDown,
  Copy,
  Clock3,
  Ear,
  Eye,
  EyeOff,
  Hash,
  Folder,
  History,
  Inbox,
  Info,
  Menu,
  MessageCircle,
  Plus,
  Reply,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  UserRound,
  Users,
  Brain,
  X,
} from "lucide-react";

const iconComponents = {
  arrowDown: ArrowDown,
  back: ArrowLeft,
  atSign: AtSign,
  bell: Bell,
  bot: Bot,
  clock: Clock3,
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
  info: Info,
  folder: Folder,
  listen: Ear,
  memory: Brain,
  message: MessageCircle,
  members: Users,
  menu: Menu,
  plus: Plus,
  reply: Reply,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  server: Server,
  user: UserRound,
  work: Briefcase,
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
