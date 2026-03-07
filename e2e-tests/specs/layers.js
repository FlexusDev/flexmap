import { expect } from 'chai';

describe('Layer CRUD', () => {
  it('should add a quad layer via the add button', async () => {
    const addBtn = await browser.$('[data-testid="add-layer-btn"]');
    await addBtn.click();

    const quadOption = await browser.$('[data-testid="add-quad"]');
    await quadOption.click();

    const layerItems = await browser.$$('[data-testid="layer-item"]');
    expect(layerItems.length).to.be.greaterThan(0);
  });

  it('should select a layer by clicking it', async () => {
    const layerItem = await browser.$('[data-testid="layer-item"]');
    await layerItem.click();

    const isSelected = await layerItem.getAttribute('data-selected');
    expect(isSelected).to.equal('true');
  });

  it('should delete the selected layer via Delete key', async () => {
    const layerItems = await browser.$$('[data-testid="layer-item"]');
    const countBefore = layerItems.length;

    await browser.keys(['Delete']);

    const layerItemsAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layerItemsAfter.length).to.equal(countBefore - 1);
  });
});
