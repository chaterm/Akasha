import type { Node as PMNode } from '@tiptap/pm/model';
import type { Decoration, DecorationSource, NodeView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/core';

const isTouchEvent = (e: MouseEvent | TouchEvent): e is TouchEvent => {
  return 'touches' in e;
};

export type ResizableNodeViewDirection =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-right'
  | 'top-left'
  | 'bottom-right'
  | 'bottom-left';

export type ResizableNodeDimensions = {
  width: number;
  height: number;
};

export type ResizableNodeViewOptions = {
  element: HTMLElement;

  contentElement?: HTMLElement;

  node: PMNode;

  editor: Editor;

  getPos: () => number | undefined;

  onResize?: (width: number, height: number) => void;

  onCommit: (width: number, height: number) => void;

  onUpdate: NodeView['update'];

  options?: {
    directions?: ResizableNodeViewDirection[];

    min?: Partial<ResizableNodeDimensions>;

    max?: Partial<ResizableNodeDimensions>;

    preserveAspectRatio?: boolean;

    className?: {
      container?: string;
      wrapper?: string;
      handle?: string;
      resizing?: string;
    };

    createCustomHandle?: (direction: ResizableNodeViewDirection) => HTMLElement;
  };
};

export class ResizableNodeView {
  node: PMNode;

  editor: Editor;

  element: HTMLElement;

  contentElement?: HTMLElement;

  container: HTMLElement;

  wrapper: HTMLElement;

  getPos: () => number | undefined;

  onResize?: (width: number, height: number) => void;

  onCommit: (width: number, height: number) => void;

  onUpdate?: NodeView['update'];

  directions: ResizableNodeViewDirection[] = [
    'bottom-left',
    'bottom-right',
    'top-left',
    'top-right',
  ];

  minSize: ResizableNodeDimensions = {
    height: 8,
    width: 8,
  };

  maxSize?: Partial<ResizableNodeDimensions>;

  preserveAspectRatio: boolean = false;

  classNames = {
    container: '',
    wrapper: '',
    handle: '',
    resizing: '',
  };

  createCustomHandle?: (direction: ResizableNodeViewDirection) => HTMLElement;

  private initialWidth: number = 0;

  private initialHeight: number = 0;

  private aspectRatio: number = 1;

  private isResizing: boolean = false;

  private activeHandle: ResizableNodeViewDirection | null = null;

  private startX: number = 0;

  private startY: number = 0;

  private startWidth: number = 0;

  private startHeight: number = 0;

  private isShiftKeyPressed: boolean = false;

  private lastEditableState: boolean | undefined = undefined;

  private handleMap = new Map<ResizableNodeViewDirection, HTMLElement>();

  constructor(options: ResizableNodeViewOptions) {
    this.node = options.node;
    this.editor = options.editor;
    this.element = options.element;
    this.contentElement = options.contentElement;

    this.getPos = options.getPos;

    this.onResize = options.onResize;
    this.onCommit = options.onCommit;
    this.onUpdate = options.onUpdate;

    if (options.options?.min) {
      this.minSize = {
        ...this.minSize,
        ...options.options.min,
      };
    }

    if (options.options?.max) {
      this.maxSize = options.options.max;
    }

    if (options?.options?.directions) {
      this.directions = options.options.directions;
    }

    if (options.options?.preserveAspectRatio) {
      this.preserveAspectRatio = options.options.preserveAspectRatio;
    }

    if (options.options?.className) {
      this.classNames = {
        container: options.options.className.container || '',
        wrapper: options.options.className.wrapper || '',
        handle: options.options.className.handle || '',
        resizing: options.options.className.resizing || '',
      };
    }

    if (options.options?.createCustomHandle) {
      this.createCustomHandle = options.options.createCustomHandle;
    }

    this.wrapper = this.createWrapper();
    this.container = this.createContainer();

    this.applyInitialSize();

    if (this.editor.isEditable) {
      this.attachHandles();
    }

    this.editor.on('update', this.handleEditorUpdate.bind(this));
  }

  get dom() {
    return this.container;
  }

  get contentDOM(): HTMLElement | null {
    return this.contentElement ?? null;
  }

  private handleEditorUpdate() {
    const isEditable = this.editor.isEditable;

    if (isEditable === this.lastEditableState) {
      return;
    }

    this.lastEditableState = isEditable;

    if (!isEditable) {
      this.removeHandles();
    } else if (isEditable && this.handleMap.size === 0) {
      this.attachHandles();
    }
  }

  update(
    node: PMNode,
    decorations: readonly Decoration[],
    innerDecorations: DecorationSource,
  ): boolean {
    if (node.type !== this.node.type) {
      return false;
    }

    this.node = node;

    if (this.onUpdate) {
      return this.onUpdate(node, decorations, innerDecorations);
    }

    return true;
  }

  destroy() {
    if (this.isResizing) {
      this.container.dataset.resizeState = 'false';

      if (this.classNames.resizing) {
        this.container.classList.remove(this.classNames.resizing);
      }

      document.removeEventListener('mousemove', this.handleMouseMove);
      document.removeEventListener('touchmove', this.handleTouchMove);
      document.removeEventListener('mouseup', this.handleMouseUp);
      document.removeEventListener('touchend', this.handleMouseUp);
      window.removeEventListener('blur', this.handleMouseUp);
      document.removeEventListener('keydown', this.handleKeyDown);
      document.removeEventListener('keyup', this.handleKeyUp);
      this.isResizing = false;
      this.activeHandle = null;
    }

    this.editor.off('update', this.handleEditorUpdate.bind(this));

    this.container.remove();
  }

  createContainer() {
    const element = document.createElement('div');
    element.dataset.resizeContainer = '';
    element.dataset.node = this.node.type.name;
    element.style.display = 'flex';

    if (this.classNames.container) {
      element.className = this.classNames.container;
    }

    element.appendChild(this.wrapper);

    return element;
  }

  createWrapper() {
    const element = document.createElement('div');
    element.style.position = 'relative';
    element.style.display = 'block';
    element.dataset.resizeWrapper = '';

    if (this.classNames.wrapper) {
      element.className = this.classNames.wrapper;
    }

    element.appendChild(this.element);

    return element;
  }

  private createHandle(direction: ResizableNodeViewDirection): HTMLElement {
    const handle = document.createElement('div');
    handle.dataset.resizeHandle = direction;
    handle.style.position = 'absolute';

    if (this.classNames.handle) {
      handle.className = this.classNames.handle;
    }

    return handle;
  }

  private positionHandle(
    handle: HTMLElement,
    direction: ResizableNodeViewDirection,
  ): void {
    const isTop = direction.includes('top');
    const isBottom = direction.includes('bottom');
    const isLeft = direction.includes('left');
    const isRight = direction.includes('right');

    if (isTop) {
      handle.style.top = '0';
    }

    if (isBottom) {
      handle.style.bottom = '0';
    }

    if (isLeft) {
      handle.style.left = '0';
    }

    if (isRight) {
      handle.style.right = '0';
    }

    if (direction === 'top' || direction === 'bottom') {
      handle.style.left = '0';
      handle.style.right = '0';
    }

    if (direction === 'left' || direction === 'right') {
      handle.style.top = '0';
      handle.style.bottom = '0';
    }
  }

  private attachHandles(): void {
    this.directions.forEach((direction) => {
      let handle: HTMLElement;

      if (this.createCustomHandle) {
        handle = this.createCustomHandle(direction);
      } else {
        handle = this.createHandle(direction);
      }

      if (!(handle instanceof HTMLElement)) {
        console.warn(
          `[ResizableNodeView] createCustomHandle("${direction}") did not return an HTMLElement. Falling back to default handle.`,
        );
        handle = this.createHandle(direction);
      }

      if (!this.createCustomHandle) {
        this.positionHandle(handle, direction);
      }

      handle.addEventListener('mousedown', (event) =>
        this.handleResizeStart(event, direction),
      );
      handle.addEventListener('touchstart', (event) =>
        this.handleResizeStart(event as unknown as MouseEvent, direction),
      );

      this.handleMap.set(direction, handle);

      this.wrapper.appendChild(handle);
    });
  }

  private removeHandles(): void {
    this.handleMap.forEach((el) => el.remove());
    this.handleMap.clear();
  }

  private applyInitialSize(): void {
    const width = this.node.attrs.width as number | undefined;
    const height = this.node.attrs.height as number | undefined;

    if (width) {
      this.element.style.width = `${width}px`;
      this.initialWidth = width;
    } else {
      this.initialWidth = this.element.offsetWidth;
    }

    if (height) {
      this.element.style.height = `${height}px`;
      this.initialHeight = height;
    } else {
      this.initialHeight = this.element.offsetHeight;
    }

    if (this.initialWidth > 0 && this.initialHeight > 0) {
      this.aspectRatio = this.initialWidth / this.initialHeight;
    }
  }

  private handleResizeStart(
    event: MouseEvent | TouchEvent,
    direction: ResizableNodeViewDirection,
  ): void {
    event.preventDefault();
    event.stopPropagation();

    this.isResizing = true;
    this.activeHandle = direction;

    if (isTouchEvent(event)) {
      this.startX = event.touches[0].clientX;
      this.startY = event.touches[0].clientY;
    } else {
      this.startX = event.clientX;
      this.startY = event.clientY;
    }

    this.startWidth = this.element.offsetWidth;
    this.startHeight = this.element.offsetHeight;

    if (this.startWidth > 0 && this.startHeight > 0) {
      this.aspectRatio = this.startWidth / this.startHeight;
    }

    const pos = this.getPos();
    if (pos !== undefined) {
      // TODO: Select the node in the editor
    }

    this.container.dataset.resizeState = 'true';

    if (this.classNames.resizing) {
      this.container.classList.add(this.classNames.resizing);
    }

    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('touchmove', this.handleTouchMove);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('touchend', this.handleMouseUp);
    window.addEventListener('blur', this.handleMouseUp);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.isResizing || !this.activeHandle) {
      return;
    }

    const deltaX = event.clientX - this.startX;
    const deltaY = event.clientY - this.startY;

    this.handleResize(deltaX, deltaY);
  };

  private handleTouchMove = (event: TouchEvent): void => {
    if (!this.isResizing || !this.activeHandle) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    const deltaX = touch.clientX - this.startX;
    const deltaY = touch.clientY - this.startY;

    this.handleResize(deltaX, deltaY);
  };

  private handleResize(deltaX: number, deltaY: number) {
    if (!this.activeHandle) {
      return;
    }

    const shouldPreserveAspectRatio =
      this.preserveAspectRatio || this.isShiftKeyPressed;
    const { width, height } = this.calculateNewDimensions(
      this.activeHandle,
      deltaX,
      deltaY,
    );
    const constrained = this.applyConstraints(
      width,
      height,
      shouldPreserveAspectRatio,
    );

    this.element.style.width = `${constrained.width}px`;
    this.element.style.height = `${constrained.height}px`;

    if (this.onResize) {
      this.onResize(constrained.width, constrained.height);
    }
  }

  private handleMouseUp = (): void => {
    if (!this.isResizing) {
      return;
    }

    const finalWidth = this.element.offsetWidth;
    const finalHeight = this.element.offsetHeight;

    this.onCommit(finalWidth, finalHeight);

    this.isResizing = false;
    this.activeHandle = null;

    this.container.dataset.resizeState = 'false';

    if (this.classNames.resizing) {
      this.container.classList.remove(this.classNames.resizing);
    }

    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('touchmove', this.handleTouchMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('touchend', this.handleMouseUp);
    window.removeEventListener('blur', this.handleMouseUp);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') {
      this.isShiftKeyPressed = true;
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') {
      this.isShiftKeyPressed = false;
    }
  };

  private calculateNewDimensions(
    direction: ResizableNodeViewDirection,
    deltaX: number,
    deltaY: number,
  ): ResizableNodeDimensions {
    let newWidth = this.startWidth;
    let newHeight = this.startHeight;

    const isRight = direction.includes('right');
    const isLeft = direction.includes('left');
    const isBottom = direction.includes('bottom');
    const isTop = direction.includes('top');

    if (isRight) {
      newWidth = this.startWidth + deltaX;
    } else if (isLeft) {
      newWidth = this.startWidth - deltaX;
    }

    if (isBottom) {
      newHeight = this.startHeight + deltaY;
    } else if (isTop) {
      newHeight = this.startHeight - deltaY;
    }

    if (direction === 'right' || direction === 'left') {
      newWidth = this.startWidth + (isRight ? deltaX : -deltaX);
    }

    if (direction === 'top' || direction === 'bottom') {
      newHeight = this.startHeight + (isBottom ? deltaY : -deltaY);
    }

    const shouldPreserveAspectRatio =
      this.preserveAspectRatio || this.isShiftKeyPressed;

    if (shouldPreserveAspectRatio) {
      return this.applyAspectRatio(newWidth, newHeight, direction);
    }

    return { width: newWidth, height: newHeight };
  }

  private applyConstraints(
    width: number,
    height: number,
    preserveAspectRatio: boolean,
  ): ResizableNodeDimensions {
    if (!preserveAspectRatio) {
      let constrainedWidth = Math.max(this.minSize.width, width);
      let constrainedHeight = Math.max(this.minSize.height, height);

      if (this.maxSize?.width) {
        constrainedWidth = Math.min(this.maxSize.width, constrainedWidth);
      }

      if (this.maxSize?.height) {
        constrainedHeight = Math.min(this.maxSize.height, constrainedHeight);
      }

      return { width: constrainedWidth, height: constrainedHeight };
    }

    let constrainedWidth = width;
    let constrainedHeight = height;

    if (constrainedWidth < this.minSize.width) {
      constrainedWidth = this.minSize.width;
      constrainedHeight = constrainedWidth / this.aspectRatio;
    }

    if (constrainedHeight < this.minSize.height) {
      constrainedHeight = this.minSize.height;
      constrainedWidth = constrainedHeight * this.aspectRatio;
    }

    if (this.maxSize?.width && constrainedWidth > this.maxSize.width) {
      constrainedWidth = this.maxSize.width;
      constrainedHeight = constrainedWidth / this.aspectRatio;
    }

    if (this.maxSize?.height && constrainedHeight > this.maxSize.height) {
      constrainedHeight = this.maxSize.height;
      constrainedWidth = constrainedHeight * this.aspectRatio;
    }

    return { width: constrainedWidth, height: constrainedHeight };
  }

  private applyAspectRatio(
    width: number,
    height: number,
    direction: ResizableNodeViewDirection,
  ): ResizableNodeDimensions {
    const isHorizontal = direction === 'left' || direction === 'right';
    const isVertical = direction === 'top' || direction === 'bottom';

    if (isHorizontal) {
      return {
        width,
        height: width / this.aspectRatio,
      };
    }

    if (isVertical) {
      return {
        width: height * this.aspectRatio,
        height,
      };
    }

    return {
      width,
      height: width / this.aspectRatio,
    };
  }
}
