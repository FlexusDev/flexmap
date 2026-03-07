import { expect } from 'chai';

const cmdKey = process.platform === 'darwin' ? 'Meta' : 'Control';

describe('Undo / Redo', () => {
  it('should add a layer then undo it', async () => {
    // Add a layer first
    const addBtn = await browser.$('[data-testid="add-layer-btn"]');
    await addBtn.click();
    const quadOption = await browser.$('[data-testid="add-quad"]');
    await quadOption.click();

    const layersBefore = await browser.$$('[data-testid="layer-item"]');
    expect(layersBefore.length).to.be.greaterThan(0);

    // Undo
    await browser.keys([cmdKey, 'z']);
    await browser.pause(200);

    const layersAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layersAfter.length).to.equal(layersBefore.length - 1);
  });

  it('should redo after undo', async () => {
    const layersBefore = await browser.$$('[data-testid="layer-item"]');

    // Redo
    await browser.keys([cmdKey, 'Shift', 'z']);
    await browser.pause(200);

    const layersAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layersAfter.length).to.equal(layersBefore.length + 1);
  });
});
