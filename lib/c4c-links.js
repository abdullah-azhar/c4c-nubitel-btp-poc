'use strict';
/**
 * Where each "open in C4C" icon goes. Read from real links copied out of the my335945 test tenant;
 * btp-view/public/c4c-links.js turns one of these specs plus an ID into the address.
 *
 *   account  opens the account's screen, found by its UUID
 *   contact  opens the contact, found by its ContactID
 *   order    opens the sales order, found by its order ID
 *   task     opens the task, found by its UUID
 *
 * The base address contains saml2=disabled because the test tenant signs in with user and password.
 * For a tenant that uses single sign-on set C4C_LINK_BASE without it.
 */
const UI = '/BYD_COD/SalesOnDemand';

function defaultLinks(c4cUrl, baseOverride) {
  const origin = String(c4cUrl || '').replace(/\/$/, '');
  return {
    base: baseOverride || `${origin}/sap/ap/ui/clogin?saml2=disabled&app.component=%2fSAP_UI_CT%2fMain%2froot.uiccwoc&rootWindow=X&redirectUrl=%2fsap%2fpublic%2fbyd%2fruntime`,
    account: { source: `${UI}/Account/UI/COD_Account_SOWL.OWL.uicomponent`, path: '/Root/DataList[{id}]/UUID', field: 'UUID', target: `${UI}/Account/UI/COD_Account_TI.TI.uicomponent`, uuid: true },
    contact: { source: `${UI}/Contact/UI/COD_Contact_QT.QT.uicomponent`, path: '/Root/InternalID', field: 'InternalID', target: `${UI}/Contact/UI/COD_Contact_TI.TI.uicomponent` },
    order: { source: `${UI}/SalesOrder/UI/COD_SALESORDER_QT.QT.uicomponent`, path: '/Root/ID', field: 'ID', target: `${UI}/SalesOrder/UI/COD_SALESORDER_TI.TI.uicomponent` },
    task: { source: `${UI}/Activities/Task/UI/COD_Task_QT.QT.uicomponent`, path: '/Root/TaskUUID', field: 'TaskUUID', target: `${UI}/Activities/Task/UI/COD_Task.TI.uicomponent`, uuid: true },
  };
}

module.exports = { defaultLinks };
