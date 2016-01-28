'use strict'
const request = require('superagent')
const uuid = require('uuid4')

/**
 * @param {[Payment]} payments
 * @param {URI} sourceAccount
 * @returns {[Transfers]}
 */
export function paymentsToTransfers (payments, sourceAccount) {
  // Build the transfer list.
  const transfers = payments.map(function (payment, i) {
    const transfer = payment.source_transfers[0]
    transfer.id = transfer.ledger + '/transfers/' + encodeURIComponent(uuid())
    transfer.additional_info = {part_of_payment: payment.id}
    // Add start and endpoints in payment chain from user-provided payment object
    if (i === 0) {
      transfer.debits[0].account = sourceAccount
    } else {
      transfer.debits = payments[i - 1].destination_transfers[0].debits
    }
    return transfer
  })

  // Create final (rightmost) transfer
  const finalPayment = payments[payments.length - 1]
  const finalTransfer = finalPayment.destination_transfers[0]
  finalTransfer.id = finalTransfer.ledger + '/transfers/' + encodeURIComponent(uuid())
  finalTransfer.additional_info = {part_of_payment: finalPayment.id}
  transfers.push(finalTransfer)
  return transfers
}

/**
 * @param {[Payment]} payments
 * @param {[Transfer]} transfers
 * @return {Promise<[Transfer]>}
 */
export async function postPayments (payments, _transfers) {
  const transfers = _transfers.slice()
  for (let i = 0; i < payments.length; i++) {
    const payment = payments[i]
    payment.source_transfers = [transfers[i]]
    payment.destination_transfers = [transfers[i + 1]]
    transfers[i + 1] = (await postPayment(payment)).destination_transfers[0]
  }
  return transfers
}

/**
 * @param {Payment} payment
 * @return {Promise<Object>} the PUT response body
 */
async function postPayment (payment) {
  const paymentRes = await request
    .put(payment.id)
    .send(payment)
  if (paymentRes.status >= 400) {
    throw new Error('Remote error: ' + paymentRes.status + ' ' +
      JSON.stringify(paymentRes.body))
  }
  return paymentRes.body
}
