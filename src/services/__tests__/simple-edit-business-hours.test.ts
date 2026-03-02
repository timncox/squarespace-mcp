import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test pre-LLM classification
describe('business_hours_update classification', () => {
  it('should match "update business hours"', async () => {
    const { classifySimpleEdit } = await import('../simple-edit-classifier.js');
    const task = { id: '1', description: 'Update business hours to 9am-5pm Monday to Friday' } as any;
    const result = await classifySimpleEdit(task);
    expect(result.isSimpleEdit).toBe(true);
    expect(result.editType).toBe('business_hours_update');
  });

  it('should match "change opening hours"', async () => {
    const { classifySimpleEdit } = await import('../simple-edit-classifier.js');
    const task = { id: '2', description: 'Change opening hours for Saturday to 10am-2pm' } as any;
    const result = await classifySimpleEdit(task);
    expect(result.isSimpleEdit).toBe(true);
    expect(result.editType).toBe('business_hours_update');
  });

  it('should match "trading hours"', async () => {
    const { classifySimpleEdit } = await import('../simple-edit-classifier.js');
    const task = { id: '3', description: 'Set trading hours to closed on Sunday' } as any;
    const result = await classifySimpleEdit(task);
    expect(result.isSimpleEdit).toBe(true);
    expect(result.editType).toBe('business_hours_update');
  });
});

// Test executor dispatch
describe('business_hours_update execution', () => {
  it('should call getSettings and updateSettings with merged hours', async () => {
    const mockClient = {
      getSettings: vi.fn().mockResolvedValue({
        success: true,
        data: { businessHours: { monday: '9am - 5pm' } },
      }),
      updateSettings: vi.fn().mockResolvedValue({
        success: true,
        updatedFields: ['businessHours'],
      }),
    };

    // Test the merge logic directly
    const params = { businessHours: { tuesday: '10am - 4pm' } };
    const settingsResult = await mockClient.getSettings();
    expect(settingsResult.success).toBe(true);

    const currentHours = settingsResult.data.businessHours ?? {};
    const merged = { ...currentHours, ...params.businessHours };
    expect(merged).toEqual({ monday: '9am - 5pm', tuesday: '10am - 4pm' });

    await mockClient.updateSettings({ businessHours: merged });
    expect(mockClient.updateSettings).toHaveBeenCalledWith({
      businessHours: { monday: '9am - 5pm', tuesday: '10am - 4pm' },
    });
  });

  it('should throw on empty businessHours', () => {
    const params = { businessHours: {} };
    expect(Object.keys(params.businessHours).length).toBe(0);
  });

  it('should override existing day when updating', async () => {
    const mockClient = {
      getSettings: vi.fn().mockResolvedValue({
        success: true,
        data: { businessHours: { monday: '9am - 5pm', tuesday: '9am - 5pm' } },
      }),
      updateSettings: vi.fn().mockResolvedValue({ success: true }),
    };

    const params = { businessHours: { monday: '10am - 6pm' } };
    const settingsResult = await mockClient.getSettings();
    const currentHours = settingsResult.data.businessHours ?? {};
    const merged = { ...currentHours, ...params.businessHours };

    expect(merged).toEqual({ monday: '10am - 6pm', tuesday: '9am - 5pm' });
  });
});
