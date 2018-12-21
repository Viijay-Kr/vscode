/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { URI } from 'vs/base/common/uri';
import * as perf from 'vs/base/common/performance';
import { sequence, ignoreErrors } from 'vs/base/common/async';
import { Action, IAction } from 'vs/base/common/actions';
import { memoize } from 'vs/base/common/decorators';
import { IFilesConfiguration, ExplorerFolderContext, FilesExplorerFocusedContext, ExplorerFocusedContext, ExplorerRootContext, ExplorerResourceReadonlyContext, IExplorerService } from 'vs/workbench/parts/files/common/files';
import { NewFolderAction, NewFileAction, FileCopiedContext, RefreshExplorerView } from 'vs/workbench/parts/files/electron-browser/fileActions';
import { toResource } from 'vs/workbench/common/editor';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import * as DOM from 'vs/base/browser/dom';
import { CollapseAction2 } from 'vs/workbench/browser/viewlet';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { ExplorerDecorationsProvider } from 'vs/workbench/parts/files/electron-browser/views/explorerDecorationsProvider';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IProgressService } from 'vs/platform/progress/common/progress';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { ResourceContextKey } from 'vs/workbench/common/resources';
import { IDecorationsService } from 'vs/workbench/services/decorations/browser/decorations';
import { WorkbenchAsyncDataTree, IListService } from 'vs/platform/list/browser/listService';
import { DelayedDragHandler } from 'vs/base/browser/dnd';
import { IEditorService, SIDE_GROUP, ACTIVE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { IViewletPanelOptions, ViewletPanel } from 'vs/workbench/browser/parts/views/panelViewlet';
import { ILabelService } from 'vs/platform/label/common/label';
import { ExplorerDelegate, ExplorerAccessibilityProvider, ExplorerDataSource, FilesRenderer, FilesFilter, FileSorter } from 'vs/workbench/parts/files/electron-browser/views/explorerViewer';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IWorkbenchThemeService } from 'vs/workbench/services/themes/common/workbenchThemeService';
import { ITreeContextMenuEvent } from 'vs/base/browser/ui/tree/tree';
import { IMenuService, MenuId, IMenu } from 'vs/platform/actions/common/actions';
import { fillInContextMenuActions } from 'vs/platform/actions/browser/menuItemActionItem';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ExplorerItem } from 'vs/workbench/parts/files/common/explorerModel';
import { onUnexpectedError } from 'vs/base/common/errors';
import { ResourceLabels, IResourceLabelsContainer } from 'vs/workbench/browser/labels';

export class ExplorerView extends ViewletPanel {
	static readonly ID: string = 'workbench.explorer.fileView';

	private tree: WorkbenchAsyncDataTree<ExplorerItem | ExplorerItem[], ExplorerItem>;
	private filter: FilesFilter;

	private resourceContext: ResourceContextKey;
	private folderContext: IContextKey<boolean>;
	private readonlyContext: IContextKey<boolean>;
	private rootContext: IContextKey<boolean>;

	// Refresh is needed on the initial explorer open
	private shouldRefresh = true;
	private dragHandler: DelayedDragHandler;
	private decorationProvider: ExplorerDecorationsProvider;
	private autoReveal = false;

	constructor(
		options: IViewletPanelOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IProgressService private progressService: IProgressService,
		@IEditorService private editorService: IEditorService,
		@IPartService private partService: IPartService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDecorationsService decorationService: IDecorationsService,
		@ILabelService private labelService: ILabelService,
		@IThemeService private themeService: IWorkbenchThemeService,
		@IListService private listService: IListService,
		@IMenuService private menuService: IMenuService,
		@IClipboardService private clipboardService: IClipboardService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IExplorerService private explorerService: IExplorerService
	) {
		super({ ...(options as IViewletPanelOptions), id: ExplorerView.ID, ariaHeaderLabel: nls.localize('explorerSection', "Files Explorer Section") }, keybindingService, contextMenuService, configurationService);

		this.resourceContext = instantiationService.createInstance(ResourceContextKey);
		this.disposables.push(this.resourceContext);
		this.folderContext = ExplorerFolderContext.bindTo(contextKeyService);
		this.readonlyContext = ExplorerResourceReadonlyContext.bindTo(contextKeyService);
		this.rootContext = ExplorerRootContext.bindTo(contextKeyService);

		this.decorationProvider = new ExplorerDecorationsProvider(this.explorerService, contextService);
		decorationService.registerDecorationsProvider(this.decorationProvider);
		this.disposables.push(this.decorationProvider);
		this.disposables.push(this.resourceContext);
	}

	get name(): string {
		return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace());
	}

	get title(): string {
		return this.name;
	}

	set title(value: string) {
		// noop
	}

	// Memoized locals
	@memoize private get contributedContextMenu(): IMenu {
		const contributedContextMenu = this.menuService.createMenu(MenuId.ExplorerContext, this.tree.contextKeyService);
		this.disposables.push(contributedContextMenu);
		return contributedContextMenu;
	}

	@memoize private get fileCopiedContextKey(): IContextKey<boolean> {
		return FileCopiedContext.bindTo(this.contextKeyService);
	}

	// Split view methods

	protected renderHeader(container: HTMLElement): void {
		super.renderHeader(container);

		// Expand on drag over
		this.dragHandler = new DelayedDragHandler(container, () => this.setExpanded(true));

		const titleElement = container.querySelector('.title') as HTMLElement;
		const setHeader = () => {
			const workspace = this.contextService.getWorkspace();
			const title = workspace.folders.map(folder => folder.name).join();
			titleElement.textContent = this.name;
			titleElement.title = title;
		};

		this.disposables.push(this.contextService.onDidChangeWorkspaceName(setHeader));
		this.disposables.push(this.labelService.onDidRegisterFormatter(setHeader));
		setHeader();
	}

	protected layoutBody(size: number): void {
		this.tree.layout(size);
	}

	renderBody(container: HTMLElement): void {
		const treeContainer = DOM.append(container, DOM.$('.explorer-folders-view'));
		this.createTree(treeContainer);

		if (this.toolbar) {
			this.toolbar.setActions(this.getActions(), this.getSecondaryActions())();
		}

		this.disposables.push(this.contextService.onDidChangeWorkbenchState(() => this.setTreeInput()));
		this.disposables.push(this.labelService.onDidRegisterFormatter(() => {
			this._onDidChangeTitleArea.fire();
			this.refresh();
		}));

		this.disposables.push(this.explorerService.onDidChangeRoots(() => this.setTreeInput()));
		this.disposables.push(this.explorerService.onDidChangeItem(e => this.refresh(e)));
		this.disposables.push(this.explorerService.onDidChangeEditable(e => {
			let expandPromise = Promise.resolve(null);
			if (this.explorerService.getEditableData(e)) {
				expandPromise = this.tree.expand(e.parent);
			}
			expandPromise.then(() => this.refresh(e.parent));
		}));
		this.disposables.push(this.explorerService.onDidSelectItem(e => this.onSelectItem(e.item, e.reveal)));

		// Update configuration
		const configuration = this.configurationService.getValue<IFilesConfiguration>();
		this.onConfigurationUpdated(configuration);

		// When the explorer viewer is loaded, listen to changes to the editor input
		this.disposables.push(this.editorService.onDidActiveEditorChange(() => {
			if (this.autoReveal) {
				const activeFile = this.getActiveFile();
				if (activeFile) {
					this.explorerService.select(this.getActiveFile());
				} else {
					this.tree.setSelection([]);
				}
			}
		}));

		// Also handle configuration updates
		this.disposables.push(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(this.configurationService.getValue<IFilesConfiguration>(), e)));

		this.disposables.push(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				// If a refresh was requested and we are now visible, run it
				if (this.shouldRefresh) {
					this.shouldRefresh = false;
					this.setTreeInput().then(undefined, onUnexpectedError);
				}
			}
		}));
	}

	getActions(): IAction[] {
		const actions: Action[] = [];

		actions.push(this.instantiationService.createInstance(NewFileAction, undefined));
		actions.push(this.instantiationService.createInstance(NewFolderAction, undefined));
		actions.push(this.instantiationService.createInstance(RefreshExplorerView, RefreshExplorerView.ID, RefreshExplorerView.LABEL));
		actions.push(this.instantiationService.createInstance(CollapseAction2, this.tree, true, 'explorer-action collapse-explorer'));

		return actions;
	}

	focus(): void {
		this.tree.domFocus();
	}

	private createTree(container: HTMLElement): void {
		this.filter = this.instantiationService.createInstance(FilesFilter);
		this.disposables.push(this.filter);
		const explorerLabels = this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility } as IResourceLabelsContainer);
		this.disposables.push(explorerLabels);

		const filesRenderer = this.instantiationService.createInstance(FilesRenderer, explorerLabels);
		this.disposables.push(filesRenderer);

		this.tree = new WorkbenchAsyncDataTree(container, new ExplorerDelegate(), [filesRenderer],
			this.instantiationService.createInstance(ExplorerDataSource), {
				accessibilityProvider: new ExplorerAccessibilityProvider(),
				ariaLabel: nls.localize('treeAriaLabel', "Files Explorer"),
				identityProvider: {
					getId: stat => stat.resource
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: stat => stat.name
				},
				filter: this.filter,
				sorter: this.instantiationService.createInstance(FileSorter)
			}, this.contextKeyService, this.listService, this.themeService, this.configurationService, this.keybindingService);

		this.disposables.push(this.tree);
		// Bind context keys
		FilesExplorerFocusedContext.bindTo(this.tree.contextKeyService);
		ExplorerFocusedContext.bindTo(this.tree.contextKeyService);

		// Update resource context based on focused element
		this.disposables.push(this.tree.onDidChangeFocus(e => {
			const stat = e.elements && e.elements.length ? e.elements[0] : undefined;
			const isSingleFolder = this.contextService.getWorkbenchState() === WorkbenchState.FOLDER;
			const resource = stat ? stat.resource : isSingleFolder ? this.contextService.getWorkspace().folders[0].uri : undefined;
			this.resourceContext.set(resource);
			this.folderContext.set((isSingleFolder && !stat) || stat && stat.isDirectory);
			this.readonlyContext.set(stat && stat.isReadonly);
			this.rootContext.set(!stat || (stat && stat.isRoot));
		}));

		// Open when selecting via keyboard
		this.disposables.push(this.tree.onDidChangeSelection(e => {
			if (!e.browserEvent) {
				// Only react on selection change events caused by user interaction (ignore those which are caused by us doing tree.setSelection).
				return;
			}
			const selection = e.elements;
			// Do not react if the user is expanding selection
			if (selection && selection.length === 1) {
				let isDoubleClick = false;
				let sideBySide = false;
				let isMiddleClick = false;

				if (e.browserEvent instanceof MouseEvent) {
					isDoubleClick = e.browserEvent.detail === 2;
					isMiddleClick = e.browserEvent.button === 1;
					sideBySide = this.tree.useAltAsMultipleSelectionModifier ? (e.browserEvent.ctrlKey || e.browserEvent.metaKey) : e.browserEvent.altKey;
				}

				if (!selection[0].isDirectory) {
					// Pass focus for keyboard events and for double click
					/* __GDPR__
					"workbenchActionExecuted" : {
						"id" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
						"from": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
					}*/
					this.telemetryService.publicLog('workbenchActionExecuted', { id: 'workbench.files.openFile', from: 'explorer' });
					this.editorService.openEditor({ resource: selection[0].resource, options: { preserveFocus: (e.browserEvent instanceof MouseEvent) && !isDoubleClick, pinned: isDoubleClick || isMiddleClick } }, sideBySide ? SIDE_GROUP : ACTIVE_GROUP);
				}
			}
		}));

		this.disposables.push(this.tree.onContextMenu(e => this.onContextMenu(e)));
	}

	// React on events

	private onConfigurationUpdated(configuration: IFilesConfiguration, event?: IConfigurationChangeEvent): void {
		this.autoReveal = configuration && configuration.explorer && configuration.explorer.autoReveal;

		// Push down config updates to components of viewer
		let needsRefresh = false;
		if (this.filter) {
			needsRefresh = this.filter.updateConfiguration();
		}

		if (event && !needsRefresh) {
			needsRefresh = event.affectsConfiguration('explorer.decorations.colors')
				|| event.affectsConfiguration('explorer.decorations.badges');
		}

		// Refresh viewer as needed if this originates from a config event
		if (event && needsRefresh) {
			this.refresh();
		}
	}

	private onContextMenu(e: ITreeContextMenuEvent<ExplorerItem>): void {
		const stat = e.element;

		// update dynamic contexts
		this.fileCopiedContextKey.set(this.clipboardService.hasResources());

		const selection = this.tree.getSelection();
		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => {
				const actions: IAction[] = [];
				fillInContextMenuActions(this.contributedContextMenu, { arg: stat instanceof ExplorerItem ? stat.resource : {}, shouldForwardArgs: true }, actions, this.contextMenuService);
				return actions;
			},
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this.tree.domFocus();
				}
			},
			getActionsContext: () => selection && selection.indexOf(stat) >= 0
				? selection.map((fs: ExplorerItem) => fs.resource)
				: stat instanceof ExplorerItem ? [stat.resource] : []
		});
	}

	// General methods

	/**
	 * Refresh the contents of the explorer to get up to date data from the disk about the file structure.
	 */
	refresh(item?: ExplorerItem): Promise<void> {
		if (!this.tree || !this.isBodyVisible()) {
			this.shouldRefresh = true;
			return Promise.resolve(void 0);
		}
		const toRefresh = item || this.tree.getInput();

		return this.tree.refresh(toRefresh, true);
	}

	getOptimalWidth(): number {
		const parentNode = this.tree.getHTMLElement();
		const childNodes = ([] as HTMLElement[]).slice.call(parentNode.querySelectorAll('.explorer-item .label-name')); // select all file labels

		return DOM.getLargestChildWidth(parentNode, childNodes);
	}

	private setTreeInput(): Promise<void> {
		if (!this.isBodyVisible()) {
			this.shouldRefresh = true;
			return Promise.resolve(void 0);
		}

		const initialInputSetup = !this.tree.getInput();
		if (initialInputSetup) {
			perf.mark('willResolveExplorer');
		}
		const roots = this.explorerService.roots;
		let input: ExplorerItem | ExplorerItem[] = roots[0];
		if (this.contextService.getWorkbenchState() !== WorkbenchState.FOLDER || roots[0].isError) {
			// Display roots only when multi folder workspace
			input = roots;
		}

		const promise = this.tree.setInput(input).then(() => {
			// Find resource to focus from active editor input if set
			if (this.autoReveal && initialInputSetup) {
				const resourceToFocus = this.getActiveFile();
				if (resourceToFocus) {
					return this.explorerService.select(resourceToFocus, true);
				}
			}

			return undefined;
		}).then(() => {
			if (initialInputSetup) {
				perf.mark('didResolveExplorer');
			}
		});

		this.progressService.showWhile(promise, this.partService.isRestored() ? 800 : 1200 /* less ugly initial startup */);
		return promise;
	}

	private getActiveFile(): URI {
		const input = this.editorService.activeEditor;

		// ignore diff editor inputs (helps to get out of diffing when returning to explorer)
		if (input instanceof DiffEditorInput) {
			return undefined;
		}

		// check for files
		return toResource(input, { supportSideBySide: true });
	}

	private onSelectItem(fileStat: ExplorerItem, reveal = this.autoReveal): Promise<void> {
		if (!fileStat || !this.isBodyVisible()) {
			return Promise.resolve(void 0);
		}

		// Expand all stats in the parent chain
		const toExpand: ExplorerItem[] = [];
		let parent = fileStat.parent;
		while (parent) {
			toExpand.push(parent);
			parent = parent.parent;
		}

		return sequence(toExpand.reverse().map(s => () => ignoreErrors(this.tree.expand(s)))).then(() => {
			if (reveal) {
				this.tree.reveal(fileStat, 0.5);
			}

			if (!fileStat.isDirectory) {
				this.tree.setSelection([fileStat]); // Since folders can not be opened, only select files
			}

			this.tree.setFocus([fileStat]);
		});
	}

	collapseAll(): void {
		this.tree.collapseAll();
	}

	dispose(): void {
		if (this.dragHandler) {
			this.dragHandler.dispose();
		}
		super.dispose();
	}
}
