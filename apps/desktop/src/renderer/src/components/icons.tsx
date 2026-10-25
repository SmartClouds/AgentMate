import {
  type AbstractElement,
  icon as describeIcon,
  type IconDefinition,
} from '@fortawesome/fontawesome-svg-core';
import {
  faAnglesLeft,
  faAnglesRight,
  faArrowDown,
  faArrowLeft,
  faArrowRight,
  faArrowsRotate,
  faArrowUp,
  faArrowUpRightFromSquare,
  faBan,
  faBell,
  faBold,
  faBolt,
  faBookmark,
  faBox,
  faBoxArchive,
  faBoxOpen,
  faBug,
  faCalendarDays,
  faCamera,
  faChartColumn,
  faChartSimple,
  faCheck,
  faChevronDown,
  faChevronRight,
  faChevronUp,
  faCircleCheck,
  faCircleHalfStroke,
  faCircleInfo,
  faCirclePlay,
  faCircleQuestion,
  faCircleXmark,
  faClapperboard,
  faClock,
  faClockRotateLeft,
  faCloudArrowDown,
  faCloudArrowUp,
  faCode,
  faCodeBranch,
  faCodeCommit,
  faCodeCompare,
  faCodeMerge,
  faCodePullRequest,
  faCommentMedical,
  faComments,
  faCompress,
  faCopy,
  faCrosshairs,
  faCubes,
  faDice,
  faDisplay,
  faDownload,
  faEllipsisVertical,
  faExpand,
  faEye,
  faEyeSlash,
  faFile,
  faFileCirclePlus,
  faFileCode,
  faFileLines,
  faFilter,
  faFlask,
  faFloppyDisk,
  faFolder,
  faFolderOpen,
  faFolderPlus,
  faFolderTree,
  faGaugeHigh,
  faGear,
  faGlobe,
  faGripVertical,
  faHardDrive,
  faHeading,
  faHeartPulse,
  faImage,
  faInfinity,
  faItalic,
  faKey,
  faKeyboard,
  faLanguage,
  faLaptopCode,
  faLink,
  faLinkSlash,
  faListOl,
  faListUl,
  faLock,
  faLockOpen,
  faMagnifyingGlass,
  faMagnifyingGlassMinus,
  faMagnifyingGlassPlus,
  faMedal,
  faMemory,
  faMicrochip,
  faMicrophone,
  faMicrophoneSlash,
  faMinus,
  faMobileScreenButton,
  faMoon,
  faMugHot,
  faNetworkWired,
  faPaperclip,
  faPaperPlane,
  faPause,
  faPaw,
  faPen,
  faPlay,
  faPlug,
  faPlus,
  faPowerOff,
  faQrcode,
  faQuoteLeft,
  faRobot,
  faRocket,
  faRotate,
  faRotateLeft,
  faRotateRight,
  faRoute,
  faSatelliteDish,
  faServer,
  faShieldHalved,
  faSliders,
  faSort,
  faSpellCheck,
  faSpinner,
  faSquareCheck,
  faSquareMinus,
  faStar,
  faStop,
  faStore,
  faStrikethrough,
  faSun,
  faTable,
  faTableColumns,
  faTabletScreenButton,
  faTag,
  faTerminal,
  faThumbtack,
  faTowerBroadcast,
  faTrashCan,
  faTriangleExclamation,
  faUpload,
  faUserPlus,
  faUsers,
  faVault,
  faVideo,
  faWandMagic,
  faWandMagicSparkles,
  faWifi,
  faWindowMaximize,
  faWindowMinimize,
  faWindowRestore,
  faWrench,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import * as React from 'react';

export interface IconProps {
  className?: string;
  onClick?: React.MouseEventHandler<SVGSVGElement>;
}

/** Font Awesome's attribute names as React props, the same way its React component maps them. */
function propName(attribute: string): string {
  if (attribute === 'class') return 'className';
  if (attribute.startsWith('aria-') || attribute.startsWith('data-'))
    return attribute.toLowerCase();
  return attribute.replace(
    /[_-]+(.)?/g,
    (_, next: string | undefined) => next?.toUpperCase() ?? '',
  );
}

function toElement(element: AbstractElement | string): React.ReactNode {
  if (typeof element === 'string') return element;
  const props: Record<string, unknown> = {};
  for (const [attribute, value] of Object.entries(element.attributes ?? {})) {
    props[propName(attribute)] = value;
  }
  return React.createElement(element.tag, props, ...(element.children ?? []).map(toElement));
}

type SvgElement = React.ReactElement<
  React.SVGProps<SVGSVGElement> & React.RefAttributes<SVGSVGElement>
>;

/** More class names than this for one icon means they are generated, so stop keeping them. */
const MAX_CACHED_CLASS_NAMES = 32;

/**
 * An icon as an inline SVG, the same markup FontAwesomeIcon renders for it. That component works
 * the SVG out again on every render, which a panel of a few hundred rows (each with a handful of
 * icons) turned into a noticeable part of switching projects. Here it is worked out once per
 * class name and the element reused.
 */
function makeIcon(icon: IconDefinition): React.ForwardRefExoticComponent<IconProps> {
  const byClassName = new Map<string, SvgElement>();
  const svgFor = (className: string): SvgElement => {
    const cached = byClassName.get(className);
    if (cached) return cached;
    const [root] = describeIcon(icon, className ? { classes: className.split(' ') } : {}).abstract;
    const svg = toElement(root) as SvgElement;
    if (byClassName.size < MAX_CACHED_CLASS_NAMES) byClassName.set(className, svg);
    return svg;
  };
  const Icon = React.forwardRef<SVGSVGElement, IconProps>(({ className, ...props }, ref) => {
    const svg = svgFor(className ?? '');
    return ref || Object.keys(props).length > 0 ? React.cloneElement(svg, { ...props, ref }) : svg;
  });
  Icon.displayName = `Icon(${icon.iconName})`;
  return Icon;
}

// Names mirror the lucide-react icons they replace so call sites didn't need
// to change, only their import path.
export const ArrowDown = makeIcon(faArrowDown);
export const ArrowLeft = makeIcon(faArrowLeft);
export const ArrowRight = makeIcon(faArrowRight);
export const ArrowUp = makeIcon(faArrowUp);
export const Blocks = makeIcon(faCubes);
export const Bookmark = makeIcon(faBookmark);
export const Check = makeIcon(faCheck);
export const ChevronDown = makeIcon(faChevronDown);
export const ChevronUp = makeIcon(faChevronUp);
export const ChevronsUpDown = makeIcon(faSort);
export const Copy = makeIcon(faCopy);
export const Download = makeIcon(faDownload);
export const EllipsisVertical = makeIcon(faEllipsisVertical);
export const Eye = makeIcon(faEye);
export const EyeOff = makeIcon(faEyeSlash);
export const ExternalLink = makeIcon(faArrowUpRightFromSquare);
export const File = makeIcon(faFile);
export const FileCog = makeIcon(faGear);
export const Folder = makeIcon(faFolder);
export const FolderKanban = makeIcon(faTableColumns);
export const FolderOpen = makeIcon(faFolderOpen);
export const FolderPlus = makeIcon(faFolderPlus);
export const FolderTree = makeIcon(faFolderTree);
export const Globe = makeIcon(faGlobe);
export const LayoutDashboard = makeIcon(faGaugeHigh);
export const Monitor = makeIcon(faDisplay);
export const Moon = makeIcon(faMoon);
export const MugHot = makeIcon(faMugHot);
export const Pencil = makeIcon(faPen);
export const Plus = makeIcon(faPlus);
export const RefreshCw = makeIcon(faArrowsRotate);
export const Save = makeIcon(faFloppyDisk);
export const Search = makeIcon(faMagnifyingGlass);
export const SettingsIcon = makeIcon(faGear);
export const Sparkles = makeIcon(faWandMagicSparkles);
export const Sun = makeIcon(faSun);
export const SunMoon = makeIcon(faCircleHalfStroke);
export const Tag = makeIcon(faTag);
export const TerminalSquare = makeIcon(faTerminal);
export const Trash2 = makeIcon(faTrashCan);
export const VsInfinity = makeIcon(faInfinity);
export const Wand2 = makeIcon(faWandMagic);
export const X = makeIcon(faXmark);

// New icons for this pass of work.
export const AnglesLeft = makeIcon(faAnglesLeft);
export const AnglesRight = makeIcon(faAnglesRight);
export const Languages = makeIcon(faLanguage);
export const History = makeIcon(faClockRotateLeft);
export const Undo = makeIcon(faRotateLeft);
export const WindowMinimize = makeIcon(faWindowMinimize);
export const WindowMaximize = makeIcon(faWindowMaximize);
export const WindowRestore = makeIcon(faWindowRestore);

// System monitor icons.
export const Cpu = makeIcon(faMicrochip);
export const MemoryStick = makeIcon(faMemory);
export const NetworkIcon = makeIcon(faNetworkWired);
export const SatelliteDish = makeIcon(faSatelliteDish);
export const Route = makeIcon(faRoute);
export const HardDrive = makeIcon(faHardDrive);
export const Gpu = makeIcon(faDisplay);
export const GripVertical = makeIcon(faGripVertical);

// CLI manager icons.
export const CloudDownload = makeIcon(faCloudArrowDown);

// Prompt scheduling icons.
export const CalendarDays = makeIcon(faCalendarDays);
export const Clock = makeIcon(faClock);
export const Play = makeIcon(faPlay);
export const Pause = makeIcon(faPause);
export const Run = makeIcon(faCirclePlay);

// Notification hook icons.
export const Bell = makeIcon(faBell);
export const Paperclip = makeIcon(faPaperclip);
export const Send = makeIcon(faPaperPlane);
export const CircleCheck = makeIcon(faCircleCheck);
export const CircleInfo = makeIcon(faCircleInfo);
export const CircleQuestion = makeIcon(faCircleQuestion);
export const CircleX = makeIcon(faCircleXmark);
export const Paw = makeIcon(faPaw);
export const Robot = makeIcon(faRobot);
export const Rocket = makeIcon(faRocket);
export const TriangleAlert = makeIcon(faTriangleExclamation);

// MCP marketplace icons.
export const Plug = makeIcon(faPlug);

// Ask AI icons.
export const MessageSquare = makeIcon(faComments);
export const MessageSquarePlus = makeIcon(faCommentMedical);
export const Crosshair = makeIcon(faCrosshairs);

// Remote control icons.
export const Broadcast = makeIcon(faTowerBroadcast);
export const QrCode = makeIcon(faQrcode);
export const Link = makeIcon(faLink);
export const LinkOff = makeIcon(faLinkSlash);
export const Power = makeIcon(faPowerOff);
export const Wifi = makeIcon(faWifi);
export const Keyboard = makeIcon(faKeyboard);
export const Upload = makeIcon(faUpload);

// SSH servers icons.
export const Server = makeIcon(faServer);
export const Lock = makeIcon(faLock);
export const LockOpen = makeIcon(faLockOpen);
export const Key = makeIcon(faKey);

// Package manager tab icons.
export const Package = makeIcon(faBox);

// The App Store of a Deploy server.
export const Store = makeIcon(faStore);

// Project archive icons.
export const Archive = makeIcon(faBoxArchive);
export const ArchiveRestore = makeIcon(faBoxOpen);

// Android device cards.
export const Smartphone = makeIcon(faMobileScreenButton);
export const Tablet = makeIcon(faTabletScreenButton);
export const RotateCw = makeIcon(faRotate);
export const Camera = makeIcon(faCamera);
export const Video = makeIcon(faVideo);
export const Clapperboard = makeIcon(faClapperboard);
export const Redo = makeIcon(faRotateRight);

/** Android's robot mark, inlined so we don't need the brands icon package. */
export const Android = React.forwardRef<SVGSVGElement, IconProps>(
  ({ className, ...props }, ref) => (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
      {...props}
    >
      <path d="M17.523 15.341a.998.998 0 110-1.996.998.998 0 010 1.996m-11.046 0a.998.998 0 110-1.996.998.998 0 010 1.996m11.405-6.02l1.997-3.46a.416.416 0 00-.152-.567.416.416 0 00-.568.152l-2.022 3.503A12.293 12.293 0 0012 7.836c-1.87 0-3.626.386-5.137 1.113L4.841 5.446a.416.416 0 00-.568-.152.416.416 0 00-.152.567l1.997 3.46C2.688 11.15.492 14.55 0 18.596h24c-.492-4.046-2.688-7.447-6.118-9.275" />
    </svg>
  ),
);
Android.displayName = 'Android';

/** Docker's whale mark, inlined so we don't need the brands icon package. */
export const Docker = React.forwardRef<SVGSVGElement, IconProps>(({ className, ...props }, ref) => (
  <svg
    ref={ref}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
    className={className}
    {...props}
  >
    <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
  </svg>
));
Docker.displayName = 'Docker';

// Git tab icons.
export const GitBranch = makeIcon(faCodeBranch);
export const GitCommit = makeIcon(faCodeCommit);
export const GitPullRequest = makeIcon(faCodePullRequest);
export const GitMerge = makeIcon(faCodeMerge);
export const CloudUpload = makeIcon(faCloudArrowUp);
export const Medal = makeIcon(faMedal);

/** GitHub's mark, inlined so we don't need the brands icon package. */
export const Github = React.forwardRef<SVGSVGElement, IconProps>(({ className, ...props }, ref) => (
  <svg
    ref={ref}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden
    className={className}
    {...props}
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
));
Github.displayName = 'Github';
export const Shield = makeIcon(faShieldHalved);
export const Bug = makeIcon(faBug);
// A server core's users (Deploy, Security).
export const Users = makeIcon(faUsers);
export const UserPlus = makeIcon(faUserPlus);

// Agent tools icons.
export const Wrench = makeIcon(faWrench);
export const StopCircle = makeIcon(faStop);

// Token usage icons.
export const ChartColumn = makeIcon(faChartColumn);
export const Bolt = makeIcon(faBolt);

// Markdown editor icons.
export const Bold = makeIcon(faBold);
export const Italic = makeIcon(faItalic);
export const Strikethrough = makeIcon(faStrikethrough);
export const Heading = makeIcon(faHeading);
export const ListUnordered = makeIcon(faListUl);
export const ListOrdered = makeIcon(faListOl);
export const ListTodo = makeIcon(faSquareCheck);
export const Quote = makeIcon(faQuoteLeft);
export const Code = makeIcon(faCode);
export const Table = makeIcon(faTable);
export const HorizontalRule = makeIcon(faMinus);
export const FileText = makeIcon(faFileLines);
export const SplitView = makeIcon(faTableColumns);
export const Pin = makeIcon(faThumbtack);

// Writing check icons.
export const SpellCheck = makeIcon(faSpellCheck);
export const Ban = makeIcon(faBan);

// Voice input icons.
export const Microphone = makeIcon(faMicrophone);
export const MicrophoneSlash = makeIcon(faMicrophoneSlash);
export const Spinner = makeIcon(faSpinner);

// Security scan icons.
export const FileCode = makeIcon(faFileCode);
export const FilePlus = makeIcon(faFileCirclePlus);
export const CollapseAll = makeIcon(faSquareMinus);
export const Filter = makeIcon(faFilter);
export const Flask = makeIcon(faFlask);

// Skill favorites and usage icons.
export const Star = makeIcon(faStar);
export const ChartSimple = makeIcon(faChartSimple);

// Workspace icons.
export const Workspace = makeIcon(faLaptopCode);
export const ChevronRight = makeIcon(faChevronRight);
export const CodeCompare = makeIcon(faCodeCompare);
export const Minus = makeIcon(faMinus);
export const Expand = makeIcon(faExpand);
export const Compress = makeIcon(faCompress);
export const ImageIcon = makeIcon(faImage);
export const ZoomIn = makeIcon(faMagnifyingGlassPlus);
export const ZoomOut = makeIcon(faMagnifyingGlassMinus);
export const Vault = makeIcon(faVault);
export const Dice = makeIcon(faDice);
export const Sliders = makeIcon(faSliders);
export const HeartPulse = makeIcon(faHeartPulse);
