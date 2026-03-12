import { expect } from 'chai';

describe('Layer CRUD', () => {
  it('should add a quad layer via the add button', async () => {
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
    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="layer-item"]')).length < countBefore,
      { timeout: 5000, timeoutMsg: 'Delete did not remove layer' }
    );

    const layerItemsAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layerItemsAfter.length).to.equal(countBefore - 1);
  });
});
