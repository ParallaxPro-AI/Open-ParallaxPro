import { createElement } from 'lucide';
import {
    Box, Circle, Sun, Camera, Volume2, Sparkles, Wifi,
    Move, RotateCw, Maximize2, Minimize2, Globe, Magnet,
    Play, Square, Save, Undo2, Redo2, Settings, Plus,
    Eye, EyeOff, Lock, Unlock, Search, Trash2, Copy, Check,
    ChevronDown, ChevronRight, Lightbulb, Layers,
    MousePointer2, Crosshair, Grid3x3, FolderOpen, File, FileCode,
    Send, MoreVertical, X, LogIn, LogOut, ExternalLink,
    ThumbsUp, ThumbsDown, RefreshCw,
} from 'lucide';

/**
 * Creates an SVG icon element from a Lucide icon definition.
 */
export function icon(iconDef: any, size: number = 14, attrs?: Record<string, string>): SVGElement {
    const el = createElement(iconDef) as unknown as SVGElement;
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            el.setAttribute(key, value);
        }
    }
    return el;
}

export {
    Box, Circle, Sun, Camera, Volume2, Sparkles, Wifi,
    Move, RotateCw, Maximize2, Minimize2, Globe, Magnet,
    Play, Square, Save, Undo2, Redo2, Settings, Plus,
    Eye, EyeOff, Lock, Unlock, Search, Trash2, Copy, Check,
    ChevronDown, ChevronRight, Lightbulb, Layers,
    MousePointer2, Crosshair, Grid3x3, FolderOpen, File, FileCode,
    Send, MoreVertical, X, LogIn, LogOut, ExternalLink,
    ThumbsUp, ThumbsDown, RefreshCw,
};
