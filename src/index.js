'use strict'
const request = require('superagent')
const uuid = require('uuid4')
const Pathfinder = require('five-bells-pathfind').Pathfinder

import {paymentsToTransfers, postPayments} from './paymentUtils'
import {
  setupTransfers,
  postTransfers,
  transferExpiresAt
} from './transferUtils'
import {
  getReceiptCondition,
  getExecutionCondition,
  getCancellationCondition
} from './conditionUtils'

/**
 * Create and execute a transaction.
 *
 * @param {Object} params
 *
 * Required for both modes:
 * @param {URI} params.sourceLedger - Ledger URI
 * @param {URI} params.sourceAccount - Account URI
 * @param {String} params.sourceUsername
 * @param {String} params.sourcePassword
 * @param {URI} params.destinationLedger - Ledger URI
 * @param {URI} params.destinationAccount - Account URI
 * @param {String} params.destinationUsername
 * @param {String} params.destinationAmount - Amount (a string, so as not to lose precision)
 *
 * Required for Atomic mode only:
 * @param {URI} params.notary - Notary URI (if provided, use Atomic mode)
 * @param {String} params.notaryPublicKey - Base64-encoded public key
 * @param {Condition} params.receiptCondition - Object, execution condition.
 *                                              If not provided, one will be generated.
 *
 * @param {String} params.destinationMemo
 */
export default async function sendPayment (params) {
  setupAccountParams(params)
  await executePayment((await findPath({
    sourceLedger: params.sourceLedger,
    destinationLedger: params.destinationLedger,
    destinationAccount: params.destinationAccount,
    destinationAmount: params.destinationAmount
  })), params)
}

/**
 * Execute a transaction.
 *
 * @param {[Object]} subpayments - The quoted payment path.
 * @param {Object} params
 *
 * Required for both modes:
 * @param {URI} params.sourceLedger - Ledger URI
 * @param {URI} params.sourceAccount - Account URI
 * @param {String} params.sourceUsername
 * @param {String} params.sourcePassword
 * @param {URI} params.destinationLedger - Ledger URI
 * @param {URI} params.destinationAccount - Account URI
 * @param {String} params.destinationUsername
 * @param {String} params.destinationAmount - Amount (a string, so as not to lose precision)
 *
 * Required for Atomic mode only:
 * @param {URI} params.notary - Notary URI (if provided, use Atomic mode)
 * @param {String} params.notaryPublicKey - Base64-encoded public key
 * @param {Condition} params.receiptCondition - Object, execution condition.
 *                                              If not provided, one will be generated.
 *
 * @param {String} params.destinationMemo
 */
export async function executePayment (subpayments, params) {
  setupAccountParams(params)

  const {
    sourceUsername,
    sourcePassword,
    sourceAccount,
    notary,
    notaryPublicKey
  } = params
  const isAtomic = !!notary
  if (isAtomic && !notaryPublicKey) {
    throw new Error('Missing required parameter: notaryPublicKey')
  }

  let transfers = paymentsToTransfers(subpayments, sourceAccount)
  if (params.destinationMemo) {
    transfers[transfers.length - 1].credits[0].memo = params.destinationMemo
  }

  const receiptConditionState = isAtomic ? 'prepared' : 'executed'
  const receiptCondition = params.receiptCondition ||
    (await getReceiptCondition(
      transfers[transfers.length - 1],
      receiptConditionState))

  // Use one Date.now() as the base of all expiries so that when a ms passes
  // between when the source and destination expiries are calculated the
  // minMessageWindow isn't exceeded.
  const now = Date.now()

  const caseID = isAtomic && (await setupCase({
    notary,
    receiptCondition,
    transfers,
    expiresAt: transferExpiresAt(now, transfers[0])
  }))

  const conditionParams = {receiptCondition, caseID, notary, notaryPublicKey}
  const executionCondition = getExecutionCondition(conditionParams)
  const cancellationCondition = isAtomic && getCancellationCondition(conditionParams)

  setupTransfers(transfers, {
    isAtomic,
    now,
    caseID,
    executionCondition,
    cancellationCondition
  })

  // Proposal.
  await postTransfers(transfers, {sourceUsername, sourcePassword})

  // Preparation, execution.
  transfers = await postPayments(subpayments, transfers)

  // Execution (atomic)
  // If a custom receiptCondition is used, it is the recipient's
  // job to post fulfillment.
  if (isAtomic && !params.receiptCondition) {
    await postFulfillmentToNotary(transfers[transfers.length - 1], caseID)
  }
  return subpayments
}

/**
 * @param {URI} ledger
 * @param {String} username
 * @returns {URI} Account ID
 */
function ledgerToAccount (ledger, username) {
  return ledger + '/accounts/' + encodeURIComponent(username)
}

function setupAccountParams (params) {
  params.sourceAccount = params.sourceAccount ||
    ledgerToAccount(params.sourceLedger, params.sourceUsername)
  params.destinationAccount = params.destinationAccount ||
    ledgerToAccount(params.destinationLedger, params.destinationUsername)
}

// /////////////////////////////////////////////////////////////////////////////
// Quoting
// /////////////////////////////////////////////////////////////////////////////

/**
 * @param {Object} params
 * @param {String} params.sourceLedger
 * @param {String} params.destinationLedger
 * @param {String} params.destinationAmount
 * @param {String} params.destinationAccount
 * @returns {Promise} an Array of subpayments
 */
export async function findPath (params) {
  // TODO cache pathfinder so that it doesn't have to re-crawl for every payment
  const pathfinder = new Pathfinder({
    crawler: {
      initialLedgers: [params.sourceLedger, params.destinationLedger]
    }
  })
  await pathfinder.crawl()
  return await pathfinder.findPath(params)
}

// /////////////////////////////////////////////////////////////////////////////
// Atomic mode
// /////////////////////////////////////////////////////////////////////////////

/**
 * @param {Object} params
 * @param {URI} params.notary
 * @param {Condition} params.receiptCondition
 * @param {[Transfer]} params.transfers
 * @param {String} params.expiresAt
 * @returns {Promise<URI>} Case ID
 */
async function setupCase (params) {
  const caseID = params.notary + '/cases/' + encodeURIComponent(uuid())
  const caseRes = await request
    .put(caseID)
    .send({
      id: caseID,
      state: 'proposed',
      execution_condition: params.receiptCondition,
      expires_at: params.expiresAt,
      notaries: [{url: params.notary}],
      transfers: params.transfers.map(transfer => transfer.id)
    })
  if (caseRes.statusCode >= 400) {
    throw new Error('Notary error: ' + caseRes.statusCode + ' ' +
      JSON.stringify(caseRes.body))
  }
  return caseID
}

/**
 * @param {Transfer} finalTransfer
 * @param {URI} caseID
 * @param {Promise}
 */
async function postFulfillmentToNotary (finalTransfer, caseID) {
  const finalTransferStateRes = await request.get(finalTransfer.id + '/state')
  if (finalTransferStateRes.statusCode >= 400) {
    throw new Error('Remote error: ' + finalTransferStateRes.statusCode + ' ' +
      JSON.stringify(finalTransferStateRes.body))
  }
  const state = finalTransferStateRes.body

  const notaryFulfillmentRes = await request
    .put(caseID + '/fulfillment')
    .send({ type: state.type, signature: state.signature })
  if (notaryFulfillmentRes >= 400) {
    throw new Error('Remote error: ' + notaryFulfillmentRes.statusCode + ' ' +
      JSON.stringify(notaryFulfillmentRes.body))
  }
}
