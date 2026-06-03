export interface CodeBlockProps {
  code?: string;
  lang?: 'shell' | 'typescript' | 'json';
  theme?: 'dark-plus';
  // Base Style Props
  base?: string;
  rounded?: string;
  shadow?: string;
  classes?: string;
  // Pre Style Props
  preBase?: string;
  prePadding?: string;
  preClasses?: string;
}
