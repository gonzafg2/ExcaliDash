import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { UploadStatus } from './UploadStatus';
import type { Collection } from '../types';
import clsx from 'clsx';

interface LayoutProps {
  children: React.ReactNode;
  collections: Collection[];
  selectedCollectionId: string | null | undefined;
  onSelectCollection: (id: string | null | undefined) => void;
  onCreateCollection: (name: string) => void;
  onEditCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
  onDrop?: (e: React.DragEvent, collectionId: string | null) => void;
}

export const Layout: React.FC<LayoutProps> = ({
  children,
  collections,
  selectedCollectionId,
  onSelectCollection,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
  onDrop
}) => {
  const location = useLocation();
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [isResizing, setIsResizing] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Handle mouse down on resize handle
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const diff = e.clientX - startXRef.current;
      const newWidth = Math.max(200, Math.min(600, startWidthRef.current + diff));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Cleanup event listeners on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', () => {});
      document.removeEventListener('mouseup', () => {});
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)');
    const sync = () => {
      setIsMobile(mq.matches);
      setIsSidebarOpen(!mq.matches);
    };

    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    setIsSidebarOpen(false);
  }, [isMobile, location.pathname, location.search]);

  return (
    <div className="h-screen w-full bg-[#F3F4F6] dark:bg-neutral-950 p-2 sm:p-4 transition-colors duration-200 overflow-hidden">
      {isMobile ? (
        <div className="relative h-full min-w-0">
          <main className="h-full min-w-0 bg-white/40 dark:bg-neutral-900/40 backdrop-blur-sm rounded-2xl border border-white/50 dark:border-neutral-800/50 shadow-sm transition-colors duration-200 overflow-hidden flex flex-col">
            <div className="px-3 pt-3 flex-shrink-0">
              <button
                type="button"
                onClick={() => setIsSidebarOpen(v => !v)}
                className="inline-flex items-center justify-center h-11 w-11 rounded-xl border-2 border-black dark:border-neutral-700 bg-white/90 dark:bg-neutral-900/90 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] backdrop-blur-sm text-slate-900 dark:text-neutral-200 hover:-translate-y-0.5 transition-all"
                title={isSidebarOpen ? 'Close menu' : 'Open menu'}
                aria-label={isSidebarOpen ? 'Close menu' : 'Open menu'}
              >
                {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
            </div>

            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="max-w-[1600px] w-full mx-auto p-4 sm:p-6 lg:p-8 min-h-full">
                {children}
              </div>
            </div>
          </main>

          <div
            className={clsx(
              'fixed inset-0 z-30 bg-neutral-900/20 backdrop-blur-sm transition-opacity duration-150',
              isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
            )}
            onClick={() => setIsSidebarOpen(false)}
          />

          <aside
            ref={sidebarRef}
            className={clsx(
              'fixed inset-y-4 left-2 sm:left-4 z-40 bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] overflow-hidden transition-transform duration-200',
              isSidebarOpen ? 'translate-x-0' : '-translate-x-[110%]'
            )}
            style={{ width: `${sidebarWidth}px` }}
          >
            <Sidebar
              collections={collections}
              selectedCollectionId={selectedCollectionId}
              onSelectCollection={onSelectCollection}
              onCreateCollection={onCreateCollection}
              onEditCollection={onEditCollection}
              onDeleteCollection={onDeleteCollection}
              onDrop={onDrop}
            />

            <div
              className={`absolute top-0 right-0 w-1.5 h-full cursor-col-resize bg-transparent hover:bg-indigo-400 dark:hover:bg-indigo-500 transition-all duration-150 ${isResizing ? 'bg-indigo-500 dark:bg-indigo-400 w-2' : ''} group`}
              onMouseDown={handleMouseDown}
              title="Drag to resize sidebar"
            >
              <div className="absolute inset-y-0 -left-0.5 -right-0.5 bg-transparent hover:bg-indigo-500/10 dark:hover:bg-indigo-400/10 transition-colors duration-150" />
            </div>
          </aside>
        </div>
      ) : (
        <div className="flex gap-3 sm:gap-4 items-start h-full min-w-0">
          <aside 
            ref={sidebarRef}
            className="flex-shrink-0 h-full bg-white dark:bg-neutral-900 rounded-2xl border-2 border-black dark:border-neutral-700 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] overflow-hidden z-20 transition-colors duration-200 relative"
            style={{ width: `${sidebarWidth}px` }}
          >
            <Sidebar
              collections={collections}
              selectedCollectionId={selectedCollectionId}
              onSelectCollection={onSelectCollection}
              onCreateCollection={onCreateCollection}
              onEditCollection={onEditCollection}
              onDeleteCollection={onDeleteCollection}
              onDrop={onDrop}
            />
            
            {/* Resize Handle */}
            <div
              className={`absolute top-0 right-0 w-1.5 h-full cursor-col-resize bg-transparent hover:bg-indigo-400 dark:hover:bg-indigo-500 transition-all duration-150 ${isResizing ? 'bg-indigo-500 dark:bg-indigo-400 w-2' : ''} group`}
              onMouseDown={handleMouseDown}
              title="Drag to resize sidebar"
            >
              <div className="absolute inset-y-0 -left-0.5 -right-0.5 bg-transparent hover:bg-indigo-500/10 dark:hover:bg-indigo-400/10 transition-colors duration-150" />
            </div>
          </aside>
          <main className="flex-1 min-w-0 bg-white/40 dark:bg-neutral-900/40 backdrop-blur-sm rounded-2xl border border-white/50 dark:border-neutral-800/50 shadow-sm h-full transition-colors duration-200 overflow-y-auto">
            <div className="max-w-[1600px] w-full mx-auto p-4 sm:p-6 lg:p-8 min-h-full">
              {children}
            </div>
          </main>
        </div>
      )}
      <UploadStatus />
    </div>
  );
};
