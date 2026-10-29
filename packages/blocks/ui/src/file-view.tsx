'use client';
import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';

export type FileBlockProps = {
  fileId: string;
  image: boolean;
  editable: boolean;
  alt?: string;
  width?: number;
  onChange(id: string): void;
};
/** The host owns credentials, transport and access fences; models never import this entry. */
export const FileBlockContext = createContext<ComponentType<FileBlockProps> | null>(null);
export function FileBlockView(props: FileBlockProps) {
  const View = useContext(FileBlockContext);
  return View ? <View {...props} /> : <span>Fichier : ouvrez la page pour le consulter.</span>;
}
