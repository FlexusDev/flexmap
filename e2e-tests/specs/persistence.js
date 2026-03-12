import { expect } from 'chai';

const cmdKey = process.platform === 'darwin' ? 'Meta' : 'Control';

describe('Undo / Redo', () => {
  it('should add a layer then undo it', async () => {
    // Add a layer first
    const addBtn = await browser.$('[data-testid="add-layer-btn"]');
    await addBtn.waitForClickable({ timeout: 5000 });
    await addBtn.click();
    await browser.pause(300);

    const quadOption = await browser.$('[data-testid="add-quad"]');
    await quadOption.waitForDisplayed({ timeout: 5000 });
    await quadOption.waitForClickable({ timeout: 5000 });
    await quadOption.click();

    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="layer-item"]')).length > 0,
      { timeout: 5000, timeoutMsg: 'No layer-item appeared after adding quad' }
    );
    const layersBefore = await browser.$$('[data-testid="layer-item"]');
    expect(layersBefore.length).to.be.greaterThan(0);

    // Undo
    const countBefore = layersBefore.length;
    await browser.keys([cmdKey, 'z']);
    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="layer-item"]')).length < countBefore,
      { timeout: 5000, timeoutMsg: 'Undo did not remove layer' }
    );
    const layersAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layersAfter.length).to.equal(countBefore - 1);
  });

  it('should redo after undo', async () => {
    const layersBefore = await browser.$$('[data-testid="layer-item"]');
    const countBefore = layersBefore.length;

    // Redo
    await browser.keys([cmdKey, 'Shift', 'z']);
    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="layer-item"]')).length > countBefore,
      { timeout: 5000, timeoutMsg: 'Redo did not restore layer' }
    );
    const layersAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layersAfter.length).to.equal(countBefore + 1);
  });
});
