#include "protocol.h"

static int mod31(int value)
{
    value %= 31;
    return value < 0 ? value + 31 : value;
}

static int inverse(int value)
{
    for (int i = 1; i < 31; ++i) {
        if (mod31(value * i) == 1) return i;
    }
    return 0;
}

static int power(int base, int exponent)
{
    int result = 1;
    while (exponent--) result = mod31(result * base);
    return result;
}

static uint8_t crc8(uint32_t payload)
{
    uint8_t crc = 0;
    for (int shift = 24; shift >= 0; shift -= 8) {
        crc ^= (uint8_t)(payload >> shift);
        for (int bit = 0; bit < 8; ++bit) {
            crc = (uint8_t)((crc & 0x80) ? (crc << 1) ^ 0x07 : crc << 1);
        }
    }
    return crc;
}

bool mapper_encode(uint16_t index, uint16_t count, uint8_t words[MAPPER_CODE_WORDS])
{
    if (!words || count == 0 || count > MAPPER_MAX_LEDS || index >= count) return false;
    uint32_t payload = ((uint32_t)count << 14) | index;
    uint64_t message = ((uint64_t)payload << 8) | crc8(payload);
    for (int i = 7; i >= 0; --i) {
        words[i] = message & 31;
        message >>= 5;
    }

    int matrix[4][5];
    for (int row = 0; row < 4; ++row) {
        int sum = 0;
        for (int i = 0; i < 8; ++i) sum += words[i] * power(i + 1, row);
        for (int col = 0; col < 4; ++col) matrix[row][col] = power(col + 9, row);
        matrix[row][4] = mod31(-sum);
    }
    for (int col = 0; col < 4; ++col) {
        int inv = inverse(matrix[col][col]);
        if (!inv) return false;
        for (int j = col; j < 5; ++j) matrix[col][j] = mod31(matrix[col][j] * inv);
        for (int row = 0; row < 4; ++row) {
            if (row == col) continue;
            int factor = matrix[row][col];
            for (int j = col; j < 5; ++j)
                matrix[row][j] = mod31(matrix[row][j] - factor * matrix[col][j]);
        }
    }
    for (int i = 0; i < 4; ++i) words[i + 8] = matrix[i][4];
    return true;
}

uint8_t mapper_frame_symbol(const uint8_t words[MAPPER_CODE_WORDS], unsigned int position)
{
    if (position < 4) return position == 3 ? 4 : 5;
    position -= 4;
    if (position >= 24) return 5;
    return position % 2 == 0 ? words[position / 2] / 6 : words[position / 2] % 6;
}
