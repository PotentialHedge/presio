import {
  BarChart3,
  Bell,
  Check,
  Download,
  Eye,
  Hand,
  Megaphone,
  MessageSquare,
  PenLine,
  QrCode,
  Sparkles,
  Star,
  Timer,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PluginIcon } from "@/lib/plugins/manifest";

/** The icon Presio draws for each name a plugin may give (PLUGIN_ICONS). */
export const PLUGIN_ICON_COMPONENTS: Record<PluginIcon, LucideIcon> = {
  "qr-code": QrCode,
  "bar-chart": BarChart3,
  message: MessageSquare,
  users: Users,
  timer: Timer,
  bell: Bell,
  star: Star,
  sparkles: Sparkles,
  hand: Hand,
  check: Check,
  eye: Eye,
  megaphone: Megaphone,
  pen: PenLine,
  download: Download,
  upload: Upload,
};

export const pluginIcon = (name: PluginIcon | undefined): LucideIcon | undefined =>
  name ? PLUGIN_ICON_COMPONENTS[name] : undefined;
