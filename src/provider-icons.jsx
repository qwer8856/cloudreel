import React from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Blocks,
  BookOpen,
  Boxes,
  CirclePlay,
  Cloud,
  CloudCog,
  CloudUpload,
  Download,
  Droplets,
  FileBox,
  Files,
  FolderKanban,
  FolderSync,
  Folders,
  Gauge,
  Gem,
  Globe,
  HardDrive,
  Hash,
  Image,
  Layers,
  Link2,
  LockKeyhole,
  MemoryStick,
  Merge,
  Network,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
  SquareStack,
  Sun,
  TerminalSquare,
  Workflow,
  Users,
} from 'lucide-react';
import {
  siAkamai,
  siApachehadoop,
  siBackblaze,
  siBox,
  siCitrix,
  siCloudinary,
  siDropbox,
  siFilen,
  siFiles,
  siGooglecloudstorage,
  siGoogledrive,
  siGooglephotos,
  siHuawei,
  siIcloud,
  siInternetarchive,
  siMaildotru,
  siMega,
  siOpenstack,
  siProtondrive,
  siSeafile,
  siYandexcloud,
  siZoho,
} from 'simple-icons';

const functional = (icon, color) => ({ icon, color });
const brand = (logo, color = `#${logo.hex}`) => ({ logo, color });
const asset = (name, color) => ({ asset: name, color });

// Brand paths are bundled locally. See public/storage-icons/README.md for sources.
// Protocols and virtual backends use Lucide icons that describe their function.
export const providerIcons = {
  'openlist-115': { mark: '115', color: '#3585d3' },
  'direct-115': { mark: '115', color: '#3585d3' },
  'drive-group': functional(Users, '#428c79'),
  'openlist-123': { mark: '123', color: '#496ccf' },
  'openlist-guangya': functional(Sun, '#d49a32'),
  alias: functional(Link2, '#478f81'),
  archive: functional(Archive, '#b48a47'),
  azureblob: asset('microsoftazure', '#0078d4'),
  azurefiles: asset('microsoftazure', '#0078d4'),
  b2: brand(siBackblaze),
  box: brand(siBox),
  cache: functional(Gauge, '#5b9675'),
  chunker: functional(Blocks, '#9876b3'),
  cloudinary: brand(siCloudinary),
  combine: functional(Boxes, '#478f81'),
  compress: functional(ArchiveRestore, '#9276ad'),
  crypt: functional(ShieldCheck, '#428c79'),
  doi: functional(BookOpen, '#7d87ac'),
  drive: brand(siGoogledrive),
  drime: functional(CloudUpload, '#9876b3'),
  dropbox: brand(siDropbox),
  fichier: functional(FileBox, '#bd934e'),
  filefabric: functional(Workflow, '#5c8eb3'),
  filelu: functional(CloudUpload, '#558fd4'),
  filen: brand(siFilen, '#4c5762'),
  filescom: brand(siFiles),
  ftp: functional(ArrowUpDown, '#b88b56'),
  gofile: functional(Files, '#b49a38'),
  'google cloud storage': brand(siGooglecloudstorage, '#4285f4'),
  'google photos': brand(siGooglephotos),
  hasher: functional(Hash, '#7986b0'),
  hdfs: brand(siApachehadoop, '#3699be'),
  hidrive: functional(Cloud, '#308dc6'),
  http: functional(Globe, '#638ca7'),
  huaweidrive: brand(siHuawei, '#ce3036'),
  iclouddrive: brand(siIcloud),
  imagekit: functional(Image, '#9876b3'),
  internetarchive: brand(siInternetarchive),
  internxt: functional(LockKeyhole, '#7868bd'),
  jottacloud: functional(CloudUpload, '#ba586b'),
  koofr: functional(Folders, '#67a052'),
  linkbox: functional(Link2, '#30a2aa'),
  local: functional(HardDrive, '#7c9385'),
  mailru: brand(siMaildotru),
  mega: brand(siMega),
  memory: functional(MemoryStick, '#b67794'),
  netstorage: brand(siAkamai),
  onedrive: asset('microsoftonedrive', '#0078d4'),
  opendrive: functional(FolderSync, '#438ab7'),
  oracleobjectstorage: asset('oracle', '#e03934'),
  pcloud: functional(Cloud, '#399bb4'),
  pikpak: functional(PackageOpen, '#bd9646'),
  pixeldrain: functional(Droplets, '#4289d6'),
  premiumizeme: functional(Gem, '#9876b3'),
  protondrive: brand(siProtondrive, '#8970d4'),
  putio: functional(CirclePlay, '#689e72'),
  qingstor: functional(CloudCog, '#3986bd'),
  quatrix: functional(SquareStack, '#9276ad'),
  s3: asset('amazons3', '#569a31'),
  seafile: brand(siSeafile),
  sftp: functional(TerminalSquare, '#9475b5'),
  shade: functional(Layers, '#428b85'),
  sharefile: brand(siCitrix, '#5679ab'),
  sia: functional(Network, '#4b9a7a'),
  smb: functional(FolderKanban, '#b2944f'),
  storj: functional(Network, '#437bc8'),
  sugarsync: functional(RefreshCw, '#739f4f'),
  swift: brand(siOpenstack),
  ulozto: functional(Download, '#498ac2'),
  union: functional(Merge, '#9376b4'),
  webdav: functional(Globe, '#638bc2'),
  yandex: brand(siYandexcloud),
  zoho: brand(siZoho),
};

const defaultIcon = functional(Cloud, '#7c9385');

export function providerIconInfo(type) {
  return providerIcons[type] || defaultIcon;
}

export function ProviderIcon({ type }) {
  const info = providerIconInfo(type);
  if (info.mark)
    return (
      <svg className="provider-icon" viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M4 24h24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <text
          x="16"
          y="21"
          textAnchor="middle"
          fill="currentColor"
          fontFamily="Arial, sans-serif"
          fontSize="15"
          fontWeight="700"
        >
          {info.mark}
        </text>
      </svg>
    );
  if (info.asset) {
    return (
      <img
        className="provider-icon"
        src={`${import.meta.env.BASE_URL}storage-icons/${info.asset}.svg`}
        width="24"
        height="24"
        alt=""
        aria-hidden="true"
      />
    );
  }
  if (info.logo) {
    return (
      <svg className="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={info.logo.path} />
      </svg>
    );
  }
  const Icon = info.icon;
  return <Icon className="provider-icon" size={24} strokeWidth={1.8} aria-hidden="true" />;
}
