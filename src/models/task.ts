/** Well-known task types from email extraction. Open-ended WhatsApp requests use 'general_edit'. */
export type TaskType =
  | 'remove_content'
  | 'add_content'
  | 'upload_file_and_link'
  | 'update_menu_block'
  | 'replace_file'
  | 'general_edit';

export type TaskStatus =
  | 'pending'
  | 'confirmed'
  | 'executing'
  | 'done'
  | 'failed';

export interface Task {
  id: string;
  taskType: TaskType;
  clientName: string;
  siteId: string;
  targetPage?: string;
  contentToFind?: string;
  contentToAdd?: string;
  attachmentFilename?: string;
  attachmentPath?: string;
  /** Free-text description of what to do — fed to the browser agent */
  description?: string;
  applyToAllSites: boolean;
  groupId?: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
  status: TaskStatus;
  errorMessage?: string;
  screenshotPath?: string;
  /** Path to a reference image (e.g., WhatsApp screenshot) showing what to change */
  referenceImagePath?: string;
  /** Paths to multiple reference images (e.g., multi-image WhatsApp message) */
  imagePaths?: string[];
  originalContent?: string; // stored before edits for undo
  /** Number of execution attempts (incremented on supervisor failure) */
  attemptCount: number;
  /** Last error from the most recent failed attempt */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExtractionResult {
  tasks: Omit<Task, 'id' | 'status' | 'createdAt' | 'updatedAt'>[];
  rawEmailText: string;
  emailSubject: string;
  emailFrom: string;
}

export interface ActionResult {
  success: boolean;
  screenshotPath?: string;
  error?: string;
  originalContent?: string;
}
